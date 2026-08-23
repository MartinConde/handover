#!/usr/bin/env node
import { main, runBin } from './index.js';

const cwd = process.cwd();
process.exitCode = await main(process.argv.slice(2), { cwd, log: console.log, run: runBin(cwd) });
