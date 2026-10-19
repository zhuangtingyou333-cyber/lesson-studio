import {state,signedIn,command,units,message,type StudioState} from '../../utils/api';
Page({
  data:{ready:false,busy:false,error:'',owner:false,showForm:false,showArchived:false,enrollable:[] as StudioState['students'],students:[] as (StudioState['students'][number]&{amount:string})[],packages:[] as StudioState['packages'],studentIndex:0,packageIndex:0,sourceIndex:0,sources:['期初课时迁入','线下款项已收到']},
  async onShow(){this.setData({ready:false});if(!signedIn()){this.setData({ready:false});return;}await this.refresh();},
  async refresh(){try{const s=await state();this.setData({ready:true,error:'',owner:s.actor.role==='owner',students:s.students.map(x=>({...x,amount:units(x.balance)})),enrollable:s.students.filter(x=>x.active),studentIndex:0,packageIndex:0,packages:s.packages.filter(p=>p.active&&s.courses.some(c=>c.id===p.course_id&&c.active))});}catch(e){this.setData({error:message(e),ready:false});}},
  imports(){wx.navigateTo({url:'/pages/imports/index'});},
  filter(){this.setData({showArchived:!this.data.showArchived});},
  edit(e:WechatMiniprogram.TouchEvent){wx.navigateTo({url:'/pages/resource/index?kind=student&id='+e.currentTarget.dataset.id});},
  toggle(){this.setData({showForm:!this.data.showForm});},
  pick(e:WechatMiniprogram.PickerChange){this.setData({[e.currentTarget.dataset.key]:Number(e.detail.value)});},
  async add(e:WechatMiniprogram.FormSubmit){if(this.data.busy)return;this.setData({busy:true,error:''});try{await command('student',e.detail.value);await this.refresh();wx.showToast({title:'学员已建档'});}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
  async enroll(e:WechatMiniprogram.FormSubmit){if(this.data.busy)return;this.setData({busy:true,error:''});try{if(!this.data.enrollable.length||!this.data.packages.length)throw new Error('请先创建在读学员和可用课包');await command('enrollment',{studentId:this.data.enrollable[this.data.studentIndex].id,packageId:this.data.packages[this.data.packageIndex].id,source:this.data.sourceIndex?'receipt':'opening',received:Math.round(Number(e.detail.value.received)*100),method:'external'});await this.refresh();wx.showToast({title:'课包已开通'});}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
  async detail(e:WechatMiniprogram.TouchEvent){try{const s=await state();const id=e.currentTarget.dataset.id;const grants=s.grants.filter(x=>x.student_id===id);await wx.showModal({title:'课包明细',content:grants.map(x=>x.package_name+'：'+units(x.balance)+'次').join('\n')||'尚未开通课包',showCancel:false});}catch(e){this.setData({error:message(e)});}},
});
