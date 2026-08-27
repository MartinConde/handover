#!/usr/bin/env node
import { bins, main } from './index.js';

const cwd = process.cwd();
process.exitCode = await main(process.argv.slice(2), { cwd, log: console.log, ...bins(cwd) });
