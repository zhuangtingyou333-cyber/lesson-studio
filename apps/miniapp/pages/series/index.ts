import {state,signedIn,request,command,message,type StudioState} from '../../utils/api';
import type {ScheduleDraft,SchedulePreview} from '../../../../packages/contracts/index';
const localDate=(ms:number)=>new Date(ms+8*3600000).toISOString().slice(0,10);
Page({
  data:{ready:false,owner:false,busy:false,error:'',classId:'',classes:[] as StudioState['classes'],classIndex:0,startDate:'',endDate:'',time:'10:00',excludeDates:'',weekdays:[] as number[],days:[{value:'1',label:'一'},{value:'2',label:'二'},{value:'3',label:'三'},{value:'4',label:'四'},{value:'5',label:'五'},{value:'6',label:'六'},{value:'0',label:'日'}].map(d=>({...d,selected:false})),preview:null as SchedulePreview|null,result:''},
  onLoad(q:Record<string,string>){this.setData({classId:q.classId||'',startDate:localDate(Date.now()+86400000),endDate:localDate(Date.now()+29*86400000)});},
  async onShow(){this.setData({ready:false,preview:null});if(!signedIn())return;try{const s=await state();const classes=s.classes.filter(c=>c.active);this.setData({ready:true,owner:s.actor.role==='owner',classes,classIndex:Math.max(0,classes.findIndex(c=>c.id===this.data.classId)),error:''});}catch(e){this.setData({error:message(e)});}},
  pick(e:WechatMiniprogram.PickerChange){const key=e.currentTarget.dataset.key;this.setData({[key]:key==='classIndex'?Number(e.detail.value):e.detail.value,preview:null,result:''});},
  daysChanged(e:WechatMiniprogram.CheckboxGroupChange){this.setData({weekdays:e.detail.value.map(Number),days:this.data.days.map(d=>({...d,selected:e.detail.value.includes(d.value)})),preview:null,result:''});},
  invalidate(){this.setData({preview:null,result:''});},
  exclusionsChanged(e:WechatMiniprogram.TextareaInput){this.setData({excludeDates:e.detail.value,preview:null,result:''});},
  async previewSchedule(e:WechatMiniprogram.FormSubmit){
    if(this.data.busy)return;this.setData({busy:true,error:'',preview:null,result:''});
    try{const c=this.data.classes[this.data.classIndex];if(!c)throw new Error('请先建立班级并添加名单');
      const input:ScheduleDraft={classId:c.id,startDate:this.data.startDate,endDate:this.data.endDate,time:this.data.time,weekdays:this.data.weekdays,excludeDates:String(e.detail.value.excludeDates||'').split(/[\s,，]+/).filter(Boolean)};
      const preview=await request<SchedulePreview>('/schedule-preview','POST',input);this.setData({preview});
    }catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}
  },
  async commit(){
    if(this.data.busy||!this.data.preview?.canCommit)return;this.setData({busy:true,error:''});const preview=this.data.preview;
    try{await command('schedule_series',{schedule:preview.input,previewVersion:preview.previewVersion});this.setData({result:`已安排${preview.occurrences.length}节课，每节预约${preview.studentCount}位学员。`,preview:null});wx.showToast({title:'排课已完成'});}
    catch(e){this.setData({error:message(e)});if((e as {status?:number}).status===409)this.setData({preview:null});}
    finally{this.setData({busy:false});}
  },
  courses(){wx.switchTab({url:'/pages/schedule/index'});},
  classes(){wx.navigateTo({url:'/pages/classes/index'});},
});
