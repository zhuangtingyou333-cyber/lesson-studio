import {ensure,DomainError} from './errors.ts';
export interface WechatIdentityProvider {appId:string;exchange(code:string):Promise<{openId:string}>}
export function wechatProvider(appId:string,secret:string,fetcher:typeof fetch=fetch):WechatIdentityProvider {
  ensure(/^wx[0-9a-z]{16}$/i.test(appId)&&secret.length>=16,'AUTH_CONFIGURATION','微信登录配置不完整',503);
  return {appId,async exchange(code){
    const url=new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search=new URLSearchParams({appid:appId,secret,js_code:code,grant_type:'authorization_code'}).toString();
    try{
      const response=await fetcher(url,{signal:AbortSignal.timeout(8000),redirect:'error'});
      if(!response.ok)throw new Error('provider response');
      const body=await response.json() as Record<string,unknown>;
      if(body.errcode||typeof body.openid!=='string'||!body.openid||body.openid.length>128)throw new Error('provider response');
      // Deliberately discard session_key/unionid and never forward provider messages or URLs.
      return {openId:body.openid};
    }catch{throw new DomainError('WECHAT_LOGIN_FAILED','微信登录未完成，请重新获取登录凭证后重试',502);}
  }};
}
