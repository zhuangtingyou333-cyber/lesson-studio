import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli=process.env.WECHATIDE_CLI||path.join(homedir(),'Applications/wechatwebdevtools.app/Contents/MacOS/wechatide');
const project=fileURLToPath(new URL('../dist/miniapp/',import.meta.url)).replace(/\/$/,'');
const [tool,...args]=process.argv.slice(2);
const allowed=new Set(['check_wechatide_status','automation_runtime_info','automation_page_action','automation_element_action','automation_navigate','simulator_screenshot','get_simulator_console','get_simulator_network','simulator_refresh','simulator_open_page','compile_wxml','compile_wxss']);
if(!allowed.has(tool)||args.some(x=>/^--project(?:=|$)/.test(x)||/^--client(?:=|$)/.test(x)||x==='-c')){
  console.error('仅支持课间项目的开发/验收命令，不接受覆盖项目路径或客户端身份。');process.exit(2);
}
const argv=['-c','Codex',tool,...args];
if(tool!=='check_wechatide_status'&&!args.includes('--help'))argv.push('--project',project);
const result=spawnSync(cli,argv,{stdio:'inherit'});
if(result.error){console.error(result.error.message);process.exit(1);}
process.exit(result.status??1);
