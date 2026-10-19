import {login,logout,state,signedIn,identitySignedIn,authOptions,units,stamp,message,type Role,type StudioState} from '../../utils/api';
Page({
  data:{ready:false,busy:false,error:'',name:'',tenantName:'',role:'',roleLabel:'',pendingLeaves:0,nextTitle:'',nextTime:'',nextDetail:'',hasIdentity:false,demoEnabled:false,wechatEnabled:false,studentCount:0,available:'0',makeups:[] as (StudioState['makeups'][number]&{expiry:string;label:string;expired:boolean})[]},
  async onShow(){this.setData({ready:false,hasIdentity:identitySignedIn()});try{const options=await authOptions();this.setData({demoEnabled:options.demoLogin,wechatEnabled:options.wechatLogin});}catch(e){this.setData({error:message(e)});}if(!signedIn()){this.setData({ready:false});return;}await this.refresh();},
  async refresh(){try{const s=await state();const next=s.sessions.find(l=>l.status==='scheduled'&&new Date(l.starts_at).getTime()>Date.now()&&(s.actor.role!=='guardian'||s.bookings.some(b=>b.session_id===l.id&&b.state==='confirmed')));this.setData({ready:true,error:'',name:s.actor.name,tenantName:s.tenant.name,role:s.actor.role,roleLabel:({owner:'管理员',teacher:'老师',guardian:'家长'})[s.actor.role],nextTitle:next?.class_name||next?.course_name||'',nextTime:next?stamp(next.starts_at):'',nextDetail:next?next.teacher_name+' · '+next.room:'',pendingLeaves:s.leaves.filter(r=>r.status==='pending').length,studentCount:s.students.length,available:units(s.metrics.available),makeups:s.makeups.map(m=>({...m,expiry:stamp(m.expires_at),expired:new Date(m.expires_at).getTime()<=Date.now(),label:m.state==='available'&&new Date(m.expires_at).getTime()<=Date.now()?'已到期':({available:'待安排',reserved:'已预约',used:'已完成'} as Record<string,string>)[m.state]}))});}catch(e){this.setData({error:message(e),ready:false});}},
  async enter(e:WechatMiniprogram.TouchEvent){if(this.data.busy)return;this.setData({busy:true,error:''});try{await login(e.currentTarget.dataset.role as Role);await this.refresh();}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
  async signOut(){try{await logout();}catch{}this.setData({ready:false,hasIdentity:false});},
  account(){wx.navigateTo({url:'/pages/account/index'});},
  payroll(){wx.navigateTo({url:'/pages/payroll/index'});},
  leaves(){wx.navigateTo({url:'/pages/leaves/index'});},
  members(){wx.navigateTo({url:'/pages/members/index'});},
  courses(){wx.switchTab({url:'/pages/schedule/index'});},
  catalog(){wx.navigateTo({url:'/pages/catalog/index'});},
  classes(){wx.navigateTo({url:'/pages/classes/index'});},
  makeup(e:WechatMiniprogram.TouchEvent){const m=this.data.makeups.find(x=>x.id===e.currentTarget.dataset.id)!;wx.navigateTo({url:'/pages/choose/index?makeupId='+m.id+'&studentId='+m.student_id+'&courseId='+m.course_id});},
});
