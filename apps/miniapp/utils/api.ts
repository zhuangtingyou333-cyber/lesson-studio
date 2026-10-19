import type { StudioState, Role, IdentityOverview, MembersOverview } from '../../../packages/contracts/index';
export type { StudioState, Role, IdentityOverview, MembersOverview };
// Developer-tools loopback only. Real device / production needs HTTPS and real WeChat auth.
const API='http://127.0.0.1:4310/api';
export function request<T>(path:string,method:'GET'|'POST'='GET',data?:object,headers:Record<string,string>={}):Promise<T>{
  return new Promise((resolve,reject)=>wx.request({url:API+path,method,data,timeout:15000,header:{'Content-Type':'application/json',Authorization:'Bearer '+(wx.getStorageSync('studio-token')||''),...headers},success:r=>{
    if(r.statusCode>=200&&r.statusCode<300)resolve(r.data as T);
    else {const e=r.data as {message?:string;code?:string};if(r.statusCode===401){if(headers.Authorization)wx.removeStorageSync('identity-token');else wx.removeStorageSync('studio-token');}reject(Object.assign(new Error(e.message||'请求失败'),{status:r.statusCode,code:e.code}));}
  },fail:()=>reject(new Error('连接失败，请确认本机API已启动；仅支持开发者工具本机体验。'))}));
}
type Session={token:string;identityToken?:string;context:{userId:string;tenantId:string}};
function saveSession(r:Session){wx.setStorageSync('studio-token',r.token);wx.setStorageSync('studio-context',r.context);if(r.identityToken){wx.setStorageSync('identity-token',r.identityToken);wx.setStorageSync('identity-user',r.context.userId);}}
export async function login(role:Role){saveSession(await request<Session>('/dev-login','POST',{role}));}
export const authOptions=()=>request<{wechatLogin:boolean;demoLogin:boolean}>('/auth/options');
export const identitySignedIn=()=>!!wx.getStorageSync('identity-token');
const identityHeaders=()=>({Authorization:'Bearer '+(wx.getStorageSync('identity-token')||'')});
export const identityState=()=>request<IdentityOverview>('/identity','GET',undefined,identityHeaders());
export const membersState=()=>request<MembersOverview>('/members');
export async function enterStudio(tenantId:string){saveSession(await request<Session>('/identity/select','POST',{tenantId},identityHeaders()));}
function saveIdentity(r:{identityToken:string;userId:string}){wx.removeStorageSync('studio-token');wx.removeStorageSync('studio-context');wx.setStorageSync('identity-token',r.identityToken);wx.setStorageSync('identity-user',r.userId);}
export async function visitorLogin(persona:'visitor'|'visitor2'){await logout();saveIdentity(await request<{identityToken:string;userId:string}>('/dev-identity','POST',{persona}));}
export async function wechatLogin(){
  const code=await new Promise<string>((resolve,reject)=>wx.login({success:r=>r.code?resolve(r.code):reject(new Error('微信登录未完成')),fail:()=>reject(new Error('微信登录未完成'))}));
  const r=await request<{identityToken:string;userId:string}>('/auth/wechat','POST',{code});
  await logout();saveIdentity(r);
}
export async function logout(){
  const studio=wx.getStorageSync('studio-token'),identity=wx.getStorageSync('identity-token');
  try{if(studio)await request('/logout','POST');}finally{
    try{if(identity)await request('/logout','POST',undefined,identityHeaders());}finally{
      wx.removeStorageSync('studio-token');wx.removeStorageSync('identity-token');wx.removeStorageSync('studio-context');wx.removeStorageSync('identity-user');
    }
  }
}
export const state=()=>request<StudioState>('/state');
export async function exportLedger(){
  return shareDownload('/ledger.csv','课间-课时明细.csv');
}
export async function shareDownload(route:string,fileName:string){
  const file=await new Promise<string>((resolve,reject)=>wx.downloadFile({url:API+route,header:{Authorization:'Bearer '+(wx.getStorageSync('studio-token')||'')},success:r=>r.statusCode===200?resolve(r.tempFilePath):reject(new Error('导出失败，请重新登录后重试')),fail:()=>reject(new Error('下载失败，请检查本机API连接'))}));
  await wx.shareFileMessage({filePath:file,fileName});
}
export const signedIn=()=>!!wx.getStorageSync('studio-token');
export const command=<T=unknown>(operation:string,input:object)=>sendCommand<T>(operation,input,false);
export const identityCommand=<T=unknown>(operation:string,input:object)=>sendCommand<T>(operation,input,true);
async function sendCommand<T>(operation:string,input:object,identity:boolean):Promise<T>{
  const context=identity?wx.getStorageSync('identity-user'):wx.getStorageSync('studio-context');
  const signature=JSON.stringify({identity,context,operation,input});
  const pending=(wx.getStorageSync('studio-pending')||{}) as Record<string,string>;
  const key=pending[signature]||('mini-'+Date.now()+'-'+Math.random().toString(36).slice(2));
  pending[signature]=key;wx.setStorageSync('studio-pending',pending);
  const clear=()=>{const current=wx.getStorageSync('studio-pending')||{};delete current[signature];wx.setStorageSync('studio-pending',current);};
  try{const r=await request<T>(identity?'/identity/commands':'/commands','POST',{operation,input},{'Idempotency-Key':key,...(identity?identityHeaders():{})});clear();return r;}
  catch(e){const status=(e as {status?:number}).status;if(status&&status<500)clear();throw e;}
}
export const units=(n:number)=>String(Number((n/1000).toFixed(3)));
export function stamp(value:string){const d=new Date(new Date(value).getTime()+8*3600000);return d.toISOString().slice(5,16).replace('T',' ');}
export function message(e:unknown){return e instanceof Error?e.message:'操作未完成，请重试';}
export const stateNames:Record<string,string>={confirmed:'待点名',attended:'已到课',absent:'缺席 · 不扣课',leave:'已请假',cancelled:'已取消'};
export const kindNames:Record<string,string>={opening:'期初迁入',purchase:'购买课时',gift:'赠送课时',consume:'课程扣减',reversal:'更正返还'};
