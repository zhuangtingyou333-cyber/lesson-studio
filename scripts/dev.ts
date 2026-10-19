import { spawn } from 'node:child_process';
const commands = [['--import', 'tsx', 'apps/api/main.ts'], ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1']];
const children = commands.map(args => spawn(process.execPath, args, { stdio: 'inherit', env: process.env }));
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); process.exitCode = code; }
children.forEach(child => child.on('exit', code => stop(code ?? 0)));
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
