import {authOptions,identitySignedIn,identityState,identityCommand,enterStudio,visitorLogin,wechatLogin,logout,message,type IdentityOverview} from '../../utils/api';
const roles={owner:'管理员',teacher:'老师',guardian:'家长'};
Page({
  data:{busy:false,error:'',result:'',ready:false,name:'',wechatLogin:false,demoLogin:false,memberships:[] as (IdentityOverview['memberships'][number]&{roleLabel:string})[],claims:[] as (IdentityOverview['claims'][number]&{label:string})[]},
  async onShow(){await this.refresh();},
  async refresh(){try{
    const options=await authOptions();this.setData(options);
    if(!identitySignedIn()){this.setData({ready:false,name:'',memberships:[],claims:[]});return;}
    const s=await identityState();this.setData({ready:true,name:s.user.name,memberships:s.memberships.map(m=>({...m,roleLabel:roles[m.role]})),claims:s.claims.map(c=>({...c,label:({pending:'等待管理员核对',approved:'已通过，请选择机构进入',rejected:'未通过'})[c.status]}))});
  }catch(e){this.setData({error:message(e),ready:false});}},
  async signIn(e:WechatMiniprogram.TouchEvent){if(this.data.busy)return;this.setData({busy:true,error:'',result:''});try{const persona=e.currentTarget.dataset.persona;if(persona)await visitorLogin(persona);else await wechatLogin();await this.refresh();}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
  async select(e:WechatMiniprogram.TouchEvent){if(this.data.busy)return;this.setData({busy:true,error:''});try{await enterStudio(e.currentTarget.dataset.id);wx.switchTab({url:'/pages/home/index'});}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
  async create(e:WechatMiniprogram.FormSubmit){if(this.data.busy)return;this.setData({busy:true,error:'',result:''});try{const r=await identityCommand<{tenantId:string}>('institution_create',{name:e.detail.value.name});await enterStudio(r.tenantId);wx.switchTab({url:'/pages/home/index'});}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
  async claim(e:WechatMiniprogram.FormSubmit){if(this.data.busy)return;this.setData({busy:true,error:'',result:''});try{await identityCommand('invite_claim',e.detail.value);this.setData({result:'申请已提交。管理员核对后，才能进入机构并查看资料。'});await this.refresh();}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
  async signOut(){if(this.data.busy)return;this.setData({busy:true,error:'',result:''});try{await logout();}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});await this.refresh();}},
});
