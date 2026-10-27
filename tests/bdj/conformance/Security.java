package conformance;

import java.lang.reflect.Proxy;
import java.net.URL;
import java.net.URLClassLoader;
import java.security.AccessControlContext;
import java.security.AccessControlException;
import java.security.AccessController;
import java.security.CodeSource;
import java.security.Permission;
import java.security.Policy;
import java.security.PrivilegedActionException;
import java.security.PrivilegedExceptionAction;
import java.security.ProtectionDomain;
import java.security.cert.Certificate;

// Java access control as libbluray's BDJSecurityManager falls back on it (AccessController.checkPermission, under the
// JDK's default policy file): code with an untrusted code source is denied reflection on another loader's class, a
// property read the policy file does not grant, and modifying the root thread group, with the permission HotSpot
// names; the policy file's grant of java.version holds for it. The untrusted code runs through doPrivileged with a
// context of only its protection domain. The program itself is trusted, as the boot class path it runs from in
// Seikou's tests is: under HotSpot, a policy that grants its own code source everything and asks the default
// policy (the policy file) about every other domain.
public class Security {
    interface Check {
        Object run() throws Exception;
    }

    static AccessControlContext untrusted;

    static void check(String what, final Check c) {
        String r;
        try {
            Object v = AccessController.doPrivileged(new PrivilegedExceptionAction<Object>() {
                public Object run() throws Exception {
                    return c.run();
                }
            }, untrusted);
            r = "ok" + (v instanceof String ? " " + v : "");
        } catch (AccessControlException e) {
            Permission p = e.getPermission();
            r = "denied " + p.getClass().getName() + " \"" + p.getName() + "\" \"" + p.getActions() + "\"; " + e.getMessage();
        } catch (PrivilegedActionException e) {
            r = "failed " + e.getException();
        }
        System.out.println(what + ": " + r);
    }

    public static void main(String[] args) throws Exception {
        final Policy file = Policy.getPolicy();
        final CodeSource self = Security.class.getProtectionDomain().getCodeSource(); // null on the boot class path
        Policy.setPolicy(new Policy() {
            public boolean implies(ProtectionDomain domain, Permission permission) {
                return self != null && self.equals(domain.getCodeSource()) || file.implies(domain, permission);
            }
        });
        CodeSource source = new CodeSource(new URL("file:/untrusted/"), (Certificate[]) null);
        // as SecureClassLoader makes one for a class: permissions from the policy, consulted at each check
        untrusted = new AccessControlContext(new ProtectionDomain[] { new ProtectionDomain(source, null, null, null) });
        // a class in a loader of its own, so reflection on it is a check (a class of the caller's own loader is not)
        final Class<?> foreign = Proxy.getProxyClass(new URLClassLoader(new URL[0], null), new Class<?>[] { Runnable.class });
        System.setSecurityManager(new SecurityManager());

        check("declared members of a foreign class", new Check() {
            public Object run() {
                return foreign.getDeclaredMethods().length > 0 ? "some" : "none";
            }
        });
        check("public members of a foreign class", new Check() {
            public Object run() {
                return foreign.getMethods().length > 0 ? "some" : "none";
            }
        });
        check("read user.home", new Check() {
            public Object run() {
                return System.getProperty("user.home") == null ? "null" : "set";
            }
        });
        check("read java.version", new Check() {
            public Object run() {
                return System.getProperty("java.version") == null ? "null" : "set";
            }
        });
        check("write java.version", new Check() {
            public Object run() {
                return System.setProperty("java.version", "1.0");
            }
        });
        check("root thread group", new Check() {
            public Object run() {
                return Thread.currentThread().getThreadGroup().getParent().getName();
            }
        });
        check("own thread group", new Check() {
            public Object run() {
                return Thread.currentThread().getThreadGroup().getName();
            }
        });
        check("create class loader", new Check() {
            public Object run() {
                return new URLClassLoader(new URL[0]).getClass().getName();
            }
        });
        check("exit", new Check() {
            public Object run() {
                System.getSecurityManager().checkExit(0);
                return null;
            }
        });
        // a thread started under the untrusted context inherits it: its run(), trusted code alone on its stack, is
        // still denied what the untrusted domain lacks
        check("thread started by untrusted code reads user.home", new Check() {
            public Object run() throws Exception {
                final String[] seen = new String[1];
                Thread t = new Thread(new Runnable() {
                    public void run() {
                        try {
                            seen[0] = System.getProperty("user.home") == null ? "null" : "set";
                        } catch (SecurityException e) {
                            seen[0] = "denied " + e.getMessage();
                        }
                    }
                });
                t.start();
                t.join();
                return seen[0];
            }
        });
        // no untrusted frame on the stack: everything is allowed (the program itself has no restricted context here
        // in Seikou; under HotSpot its application code source has the default policy, which grants this read)
        System.out.println("trusted read java.version: " + (System.getProperty("java.version") == null ? "null" : "set"));
    }
}
