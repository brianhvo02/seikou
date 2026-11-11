// SPDX-License-Identifier: LGPL-3.0-or-later
import { parse, type ParseOptions } from '@seikou/demo';

const options: ParseOptions = { strict: true };
console.log(parse('abc', options));
