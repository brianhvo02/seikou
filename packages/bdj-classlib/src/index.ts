/*
 * @seikou/bdj-classlib: where the class library's three jars are served from, for an engine worker entry that loads
 * them for @seikou/bdj. The intrinsics (../intrinsics, @seikou/bdj-classlib/intrinsics) are internal: only
 * @seikou/bdj's BD-J worker entry imports them.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * This file is distributed under the class library's own licence, the GNU General Public License version 2 only with
 * the Classpath Exception (see LICENSE and ASSEMBLY_EXCEPTION in this package).
 *
 * SPDX-License-Identifier: GPL-2.0-only WITH Classpath-exception-2.0
 */

import rt from '../rt-bdj.jar?url';
import libbluray from '../libbluray-j2se.jar?url';
import libblurayAwt from '../libbluray-awt-j2se.jar?url';

/** The URLs of the class library's jars, keyed as `ClassLibrarySource` names their bytes. */
export interface ClassLibraryUrls {
  /** rt-bdj.jar: the OpenJDK 8 runtime classes the BD-J stack needs (about 4 MB). */
  readonly rt: string;
  /** libbluray-j2se.jar: libbluray's BD-J Java stack. */
  readonly libbluray: string;
  /** libbluray-awt-j2se.jar: libbluray's AWT layer. */
  readonly libblurayAwt: string;
}

/**
 * Where the bundler serves the three jars: asset URLs from Vite's `?url` imports, for an engine worker entry's
 * `loadClassLibrary` to fetch.
 */
export const CLASS_LIBRARY_URLS: ClassLibraryUrls = { rt, libbluray, libblurayAwt };
