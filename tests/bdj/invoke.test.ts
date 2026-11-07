import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Jvm } from '../../src/bdj/jvm/jvm';
import { Vfs } from '../../src/bdj/jvm/vfs';
import { ZipArchive } from '../../src/bdj/jvm/zip';
import type { JObject } from '../../src/bdj/jvm/values';
import { NativeTable, registerBootstrapNatives, registerJdkNatives, registerSchedulerNatives } from '../../src/bdj/jvm/natives/index';
import { assembleClass } from '../helpers/jvm-asm';
import type { Const } from '../helpers/jvm-asm';

const file = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const RT = file('../../src/bdj-classlib/rt-bdj.jar');

const ICONST_0 = 0x03, ICONST_1 = 0x04, ICONST_5 = 0x08, BIPUSH = 0x10, LDC_W = 0x13;
const ILOAD_0 = 0x1a, ILOAD_1 = 0x1b, ALOAD_0 = 0x2a, ASTORE_0 = 0x4b, ALOAD_2 = 0x2c, ISTORE_0 = 0x3b, ISTORE_1 = 0x3c;
const DUP = 0x59, IADD = 0x60, IINC = 0x84, IF_ICMPGE = 0xa2, GOTO = 0xa7, IRETURN = 0xac, ARETURN = 0xb0, RETURN = 0xb1;
const GETSTATIC = 0xb2, PUTSTATIC = 0xb3, PUTFIELD = 0xb5, INVOKEVIRTUAL = 0xb6, INVOKESPECIAL = 0xb7, INVOKESTATIC = 0xb8;
const INVOKEDYNAMIC = 0xba, NEW = 0xbb;
const REF_getField = 1, REF_getStatic = 2, REF_invokeVirtual = 5, REF_invokeStatic = 6, REF_newInvokeSpecial = 8, REF_invokeInterface = 9;

const BSM_DESC = '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/CallSite;';
const m = (cls: string, name: string, desc: string): { c: Const } => ({ c: ['method', cls, name, desc] });
const mh = (desc: string): { c: Const } => m('java/lang/invoke/MethodHandle', 'invokeExact', desc);
const handle = (kind: number, ref: readonly ['field' | 'method' | 'imethod', string, string, string]): { c: Const } => ({ c: ['mhandle', kind, ref] });
const TARGET = handle(REF_invokeStatic, ['method', 'Mh', 'target', '(I)I']);
const INIT_OBJECT = [ALOAD_0, INVOKESPECIAL, m('java/lang/Object', '<init>', '()V')];

describe('method handles and invokedynamic', () => {
  let jvm: Jvm;

  beforeAll(async () => {
    jvm = new Jvm({
      bootJars: [file('../../src/bdj-classlib/libbluray-j2se.jar'), file('../../src/bdj-classlib/libbluray-awt-j2se.jar'), RT],
      nowMs: () => Date.now(),
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      stdout: () => {},
      stderr: () => {},
      vfs: new Vfs({ disc: null, jdkLib: ZipArchive.open(RT), nowMs: () => Date.now() }),
    });
    await jvm.boot();
    const define = (name: string, bytes: Uint8Array): void => void jvm.loader.define(name, bytes, null, null);
    define(
      'Indy',
      assembleClass(
        'Indy',
        [
          { name: 'target', desc: '(I)I', code: [ILOAD_0, ICONST_1, IADD, IRETURN] },
          {
            name: 'bsm',
            desc: BSM_DESC,
            code: [GETSTATIC, { c: ['field', 'Indy', 'count', 'I'] }, ICONST_1, IADD, PUTSTATIC, { c: ['field', 'Indy', 'count', 'I'] },
              NEW, { c: ['class', 'java/lang/invoke/ConstantCallSite'] }, DUP, ALOAD_0, LDC_W, { c: ['class', 'Indy'] }, LDC_W, { c: ['string', 'target'] }, ALOAD_2,
              INVOKEVIRTUAL, m('java/lang/invoke/MethodHandles$Lookup', 'findStatic', '(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/MethodHandle;'),
              INVOKESPECIAL, m('java/lang/invoke/ConstantCallSite', '<init>', '(Ljava/lang/invoke/MethodHandle;)V'), ARETURN],
          },
          {
            name: 'run',
            desc: '()I',
            // s = 0; for (i = 0; i < 5; i++) s += apply(i); return s + apply(s), the second apply a separate instruction
            code: [ICONST_0, ISTORE_0, ICONST_0, ISTORE_1, ILOAD_1, ICONST_5, IF_ICMPGE, 0, 18, ILOAD_0, ILOAD_1,
              INVOKEDYNAMIC, { c: ['indy', 0, 'apply', '(I)I'] }, 0, 0, IADD, ISTORE_0, IINC, 1, 1, GOTO, 0xff, 0xef,
              ILOAD_0, ILOAD_0, INVOKEDYNAMIC, { c: ['indy', 0, 'apply', '(I)I'] }, 0, 0, IADD, IRETURN],
          },
          { name: 'count', desc: '()I', code: [GETSTATIC, { c: ['field', 'Indy', 'count', 'I'] }, IRETURN] },
        ],
        [['count', 'I']],
        'java/lang/Object',
        { bootstrapMethods: [{ ref: ['mhandle', REF_invokeStatic, ['method', 'Indy', 'bsm', BSM_DESC]], args: [] }] },
      ),
    );
    define('MhIface', assembleClass('MhIface', [{ name: 'hello', desc: '()I', access: 0x0001, code: [BIPUSH, 42, IRETURN] }], [], 'java/lang/Object', { access: 0x0601 }));
    define('MhImpl', assembleClass('MhImpl', [{ name: '<init>', desc: '()V', access: 0x0001, code: [...INIT_OBJECT, RETURN] }], [], 'java/lang/Object', { interfaces: ['MhIface'] }));
    define(
      'MhObj',
      assembleClass(
        'MhObj',
        [{ name: '<init>', desc: '()V', access: 0x0001, code: [...INIT_OBJECT, ALOAD_0, BIPUSH, 7, PUTFIELD, { c: ['field', 'MhObj', 'v', 'I'] }, RETURN] }],
        [],
        'java/lang/Object',
        { instanceFields: [['v', 'I']] },
      ),
    );
    define('MhAbs', assembleClass('MhAbs', [{ name: 'gone', desc: '()I', access: 0x0401 }], [], 'java/lang/Object', { access: 0x0601 }));
    define('MhNoImpl', assembleClass('MhNoImpl', [{ name: '<init>', desc: '()V', access: 0x0001, code: [...INIT_OBJECT, RETURN] }], [], 'java/lang/Object', { interfaces: ['MhAbs'] }));
    const newObj = (cls: string): (number | { c: Const })[] => [NEW, { c: ['class', cls] }, DUP, INVOKESPECIAL, m(cls, '<init>', '()V')];
    define(
      'Mh',
      assembleClass(
        'Mh',
        [
          { name: 'target', desc: '(I)I', code: [ILOAD_0, ICONST_1, IADD, IRETURN] },
          { name: 'exact', desc: '()I', code: [LDC_W, TARGET, BIPUSH, 41, INVOKEVIRTUAL, mh('(I)I'), IRETURN] },
          {
            name: 'generic',
            desc: '()Ljava/lang/Object;',
            code: [LDC_W, TARGET, BIPUSH, 41, INVOKESTATIC, m('java/lang/Integer', 'valueOf', '(I)Ljava/lang/Integer;'),
              INVOKEVIRTUAL, m('java/lang/invoke/MethodHandle', 'invoke', '(Ljava/lang/Integer;)Ljava/lang/Object;'), ARETURN],
          },
          {
            name: 'wrong',
            desc: '()Ljava/lang/Object;',
            code: [LDC_W, TARGET, BIPUSH, 41, INVOKESTATIC, m('java/lang/Integer', 'valueOf', '(I)Ljava/lang/Integer;'),
              INVOKEVIRTUAL, mh('(Ljava/lang/Integer;)Ljava/lang/Object;'), ARETURN],
          },
          { name: 'mtype', desc: '()Ljava/lang/String;', code: [LDC_W, { c: ['mtype', '(I)I'] }, INVOKEVIRTUAL, m('java/lang/Object', 'toString', '()Ljava/lang/String;'), ARETURN] },
          {
            name: 'mhType',
            desc: '()Ljava/lang/String;',
            code: [LDC_W, TARGET, INVOKEVIRTUAL, m('java/lang/invoke/MethodHandle', 'type', '()Ljava/lang/invoke/MethodType;'),
              INVOKEVIRTUAL, m('java/lang/Object', 'toString', '()Ljava/lang/String;'), ARETURN],
          },
          { name: 'same', desc: '()Z', code: [LDC_W, TARGET, LDC_W, TARGET, 0xa6, 0, 5, ICONST_1, IRETURN, ICONST_0, IRETURN] },
          {
            name: 'virtual',
            desc: '()I',
            code: [LDC_W, handle(REF_invokeVirtual, ['method', 'java/lang/String', 'length', '()I']), LDC_W, { c: ['string', 'four'] },
              INVOKEVIRTUAL, mh('(Ljava/lang/String;)I'), IRETURN],
          },
          {
            name: 'iface',
            desc: '()I',
            code: [LDC_W, handle(REF_invokeInterface, ['imethod', 'MhIface', 'hello', '()I']), ...newObj('MhImpl'), INVOKEVIRTUAL, mh('(LMhIface;)I'), IRETURN],
          },
          {
            name: 'ctor',
            desc: '()Ljava/lang/String;',
            code: [LDC_W, handle(REF_newInvokeSpecial, ['method', 'java/lang/StringBuilder', '<init>', '(Ljava/lang/String;)V']), LDC_W, { c: ['string', 'built'] },
              INVOKEVIRTUAL, mh('(Ljava/lang/String;)Ljava/lang/StringBuilder;'),
              INVOKEVIRTUAL, m('java/lang/StringBuilder', 'toString', '()Ljava/lang/String;'), ARETURN],
          },
          { name: 'getter', desc: '()I', code: [LDC_W, handle(REF_getField, ['field', 'MhObj', 'v', 'I']), ...newObj('MhObj'), INVOKEVIRTUAL, mh('(LMhObj;)I'), IRETURN] },
          // MethodHandle.linkToInterface(receiver, the handle's MemberName), as a DirectMethodHandle's form calls it
          ...(['wrongReceiver', 'noMethod'] as const).map((name) => ({
            name,
            desc: '()I',
            code: [LDC_W, name === 'wrongReceiver' ? handle(REF_invokeInterface, ['imethod', 'MhIface', 'hello', '()I']) : handle(REF_invokeInterface, ['imethod', 'MhAbs', 'gone', '()I']),
              INVOKEVIRTUAL, m('java/lang/invoke/MethodHandle', 'internalMemberName', '()Ljava/lang/invoke/MemberName;'), ASTORE_0,
              ...newObj(name === 'wrongReceiver' ? 'java/lang/Object' : 'MhNoImpl'), ALOAD_0,
              INVOKESTATIC, m('java/lang/invoke/MethodHandle', 'linkToInterface', '(Ljava/lang/Object;Ljava/lang/invoke/MemberName;)I'), IRETURN],
          })),
          { name: 'staticGetter', desc: '()I', code: [LDC_W, handle(REF_getStatic, ['field', 'Mh', 'n', 'I']), INVOKEVIRTUAL, mh('()I'), IRETURN] },
        ],
        [['n', 'I']],
      ),
    );
  }, 60_000);

  const call = (cls: string, name: string, desc: string): Promise<unknown> => jvm.callStatic(cls, name, desc);
  const text = async (cls: string, name: string): Promise<string | null> => jvm.heap.jsString((await call(cls, name, '()Ljava/lang/String;')) as JObject);

  it('bootstraps each invokedynamic instruction once and reuses its call site', async () => {
    expect(await call('Indy', 'run', '()I')).toBe(31);
    expect(await call('Indy', 'count', '()I')).toBe(2);
    expect(await call('Indy', 'run', '()I')).toBe(31);
    expect(await call('Indy', 'count', '()I')).toBe(2);
  });

  it('invokeExact needs the exact type; invoke converts with asType', async () => {
    expect(await call('Mh', 'exact', '()I')).toBe(42);
    const boxed = (await call('Mh', 'generic', '()Ljava/lang/Object;')) as JObject;
    expect(boxed.cls.name).toBe('java/lang/Integer');
    expect(jvm.getField(boxed, 'value', 'I')).toBe(42);
    await expect(call('Mh', 'wrong', '()Ljava/lang/Object;')).rejects.toThrow(/WrongMethodTypeException/);
  });

  it('ldc loads MethodType and MethodHandle constants, each resolved once', async () => {
    expect(await text('Mh', 'mtype')).toBe('(int)int');
    expect(await text('Mh', 'mhType')).toBe('(int)int');
    expect(await call('Mh', 'same', '()Z')).toBe(1);
  });

  it('calls a static, a virtual, an interface default method, a constructor and field getters through handles', async () => {
    expect(await call('Mh', 'virtual', '()I')).toBe(4);
    expect(await call('Mh', 'iface', '()I')).toBe(42);
    expect(await text('Mh', 'ctor')).toBe('built');
    expect(await call('Mh', 'getter', '()I')).toBe(7);
    const cls = jvm.loader.loadBoot('Mh')!;
    cls.staticValues[cls.declaredField('n', 'I')!.slot] = 99;
    expect(await call('Mh', 'staticGetter', '()I')).toBe(99);
  });

  it('linkToInterface checks the receiver and the selected method, as invokeinterface does', async () => {
    await expect(call('Mh', 'wrongReceiver', '()I')).rejects.toThrow(/IncompatibleClassChangeError: Class java.lang.Object does not implement/);
    await expect(call('Mh', 'noMethod', '()I')).rejects.toThrow(/AbstractMethodError: MhNoImpl.gone\(\)I/);
  });

  it('every Java method the VM replaces natively exists with bytecode in rt-bdj.jar', () => {
    const t = new NativeTable();
    registerBootstrapNatives(t);
    registerSchedulerNatives(t);
    registerJdkNatives(t);
    expect([...t.replaced]).toContain('java/lang/invoke/LambdaForm.compileToBytecode()Ljava/lang/invoke/MemberName;');
    for (const key of t.replaced) {
      const dot = key.indexOf('.');
      const m = jvm.loader.loadBoot(key.slice(0, dot))?.methods.get(key.slice(dot + 1));
      expect(m?.code, key).toBeTruthy();
    }
  });

  it('refuses to link a class when a replaced native names no method of it', () => {
    jvm.natives.replace({ 'Stale.gone()V': () => undefined });
    expect(() => jvm.loader.define('Stale', assembleClass('Stale', [{ name: 'here', desc: '()V', code: [RETURN] }]), null, null)).toThrow(
      /replaced native Stale.gone\(\)V names no method/,
    );
  });
});
