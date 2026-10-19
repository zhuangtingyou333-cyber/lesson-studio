import {state,signedIn,request,command,message,type StudioState} from '../../utils/api';
import type {ScheduleChangeDraft,ScheduleChangePreview,LessonPlan} from '../../../../packages/contracts/index';
const local=(v:string)=>new Date(Date.parse(v)+8*3600000).toISOString().slice(0,16).replace('T',' ');
const display=(p:LessonPlan)=>`${local(p.startsAt)} ～ ${local(p.endsAt).slice(11)} · ${p.teacherName} · ${p.room} · 上限${p.capacity}人`;
type PreviewView=ScheduleChangePreview&{rows:(ScheduleChangePreview['rows'][number]&{beforeLabel:string;afterLabel:string;studentNames:string})[]};
Page({
  data:{id:'',ready:false,owner:false,busy:false,error:'',lesson:null as StudioState['sessions'][number]|null,anchor:'',actions:['改期 / 调整老师教室','取消课程'],actionIndex:0,scopes:['仅这一节','本节及之后的系列课','系列内指定日期范围'],scopeIndex:0,fromDate:'',toDate:'',date:'',time:'',teachers:[] as {id:string;name:string}[],teacherIndex:0,rooms:[] as {id:string;name:string}[],roomIndex:0,room:'',capacity:'',reason:'',preview:null as PreviewView|null,result:''},
  onLoad(query:Record<string,string>){this.setData({id:query.id});},
  async onShow(){
    this.setData({ready:false,preview:null});if(!signedIn())return;
    try{const s=await state(),lesson=s.sessions.find(l=>l.id===this.data.id);if(!lesson)throw new Error('课程不存在或无访问权限');
      const slots=s.sessions.filter(l=>l.series_id&&l.series_id===lesson.series_id);const anchor=local(lesson.starts_at);
      this.setData({ready:true,owner:s.actor.role==='owner',lesson,anchor,error:'',teachers:[{id:'',name:'保留每节原老师'},...s.teachers],scopeIndex:lesson.series_id?this.data.scopeIndex:0,date:anchor.slice(0,10),time:anchor.slice(11),fromDate:anchor.slice(0,10),toDate:local(slots[slots.length-1]?.starts_at||lesson.starts_at).slice(0,10),teacherIndex:0,rooms:[{id:'',name:'保留每节原教室'},...s.rooms.filter(r=>r.active)],roomIndex:0});
    }catch(e){this.setData({error:message(e)});}
  },
  pick(e:WechatMiniprogram.PickerChange){const key=e.currentTarget.dataset.key;this.setData({[key]:key.endsWith('Index')?Number(e.detail.value):e.detail.value,preview:null,result:''});},
  input(e:WechatMiniprogram.Input){this.setData({[e.currentTarget.dataset.key]:e.detail.value,preview:null,result:''});},
  async previewChange(e:WechatMiniprogram.FormSubmit){
    if(this.data.busy)return;this.setData({busy:true,error:'',preview:null,result:''});
    try{const v=e.detail.value,scope=(['single','future','range'] as const)[this.data.scopeIndex];
      const base={sessionId:this.data.id,scope,reason:v.reason,...(scope==='range'?{fromDate:this.data.fromDate,toDate:this.data.toDate}:{})};
      const teacherId=this.data.teachers[this.data.teacherIndex]?.id;
      const change:ScheduleChangeDraft=this.data.actionIndex?{...base,action:'cancel'}:{...base,action:'reschedule',date:this.data.date,time:this.data.time,...(teacherId?{teacherId}:{}),...(this.data.rooms[this.data.roomIndex]?.id?{roomId:this.data.rooms[this.data.roomIndex].id}:{}),...(String(v.capacity||'').trim()?{capacity:Number(v.capacity)}:{})};
      const preview=await request<ScheduleChangePreview>('/schedule-change-preview','POST',change);
      this.setData({preview:{...preview,rows:preview.rows.map(r=>({...r,beforeLabel:display(r.before),afterLabel:r.after.status==='cancelled'?'取消课程，保留历史记录':display(r.after),studentNames:r.bookings.map(b=>b.studentName).join('、')||'暂无有效预约'}))}});
    }catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}
  },
  async commit(){
    if(this.data.busy||!this.data.preview?.canCommit)return;this.setData({busy:true,error:''});const preview=this.data.preview;
    try{await command('schedule_change',{change:preview.input,previewVersion:preview.previewVersion});this.setData({preview:null,result:`已${preview.input.action==='cancel'?'取消':'调整'}${preview.rows.length}节课，涉及${preview.affectedBookings}条预约。变更记录已保存。`});wx.showToast({title:'已保存'});}
    catch(e){this.setData({error:message(e)});if((e as {status?:number}).status===409)this.setData({preview:null});}
    finally{this.setData({busy:false});}
  },
  detail(){wx.redirectTo({url:'/pages/lesson/index?id='+this.data.id});},
  courses(){wx.switchTab({url:'/pages/schedule/index'});},
});
