import {state,signedIn,command,stamp,units,message,type StudioState} from '../../utils/api';
Page({
  data:{ready:false,error:'',busy:false,owner:false,showForm:false,sessions:[] as object[],courses:[] as StudioState['courses'],teachers:[] as StudioState['teachers'],rooms:[] as StudioState['rooms'],roomIndex:0,courseIndex:0,teacherIndex:0,date:'',time:'10:00'},
  async onShow(){this.setData({ready:false});if(!signedIn()){this.setData({ready:false});return;}await this.refresh();},
  async refresh(){try{const s=await state();this.setData({ready:true,error:'',owner:s.actor.role==='owner',sessions:s.sessions.map(x=>({...x,label:stamp(x.starts_at),cost:units(x.debit)})),courses:s.courses.filter(c=>c.active),teachers:s.teachers,rooms:s.rooms.filter(r=>r.active),courseIndex:0,teacherIndex:0,roomIndex:0});}catch(e){this.setData({error:message(e),ready:false});}},
  pick(e:WechatMiniprogram.PickerChange){const key=e.currentTarget.dataset.key;this.setData({[key]:key==='date'||key==='time'?e.detail.value:Number(e.detail.value)});},
  open(e:WechatMiniprogram.TouchEvent){wx.navigateTo({url:'/pages/lesson/index?id='+e.currentTarget.dataset.id});},
  toggle(){this.setData({showForm:!this.data.showForm,error:''});},
  series(){wx.navigateTo({url:'/pages/series/index'});},
  async save(e:WechatMiniprogram.FormSubmit){if(this.data.busy)return;this.setData({busy:true,error:''});try{if(!this.data.date)throw new Error('请选择上课日期');const v=e.detail.value;if(!this.data.courses[this.data.courseIndex]||!this.data.teachers[this.data.teacherIndex]||!this.data.rooms[this.data.roomIndex])throw new Error('请先设置可用课程、老师和教室');await command('lesson',{courseId:this.data.courses[this.data.courseIndex].id,teacherId:this.data.teachers[this.data.teacherIndex].id,roomId:this.data.rooms[this.data.roomIndex].id,capacity:Number(v.capacity),startsAt:new Date(this.data.date+'T'+this.data.time+':00+08:00').toISOString()});this.setData({showForm:false});await this.refresh();wx.showToast({title:'课程已安排'});}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
});
