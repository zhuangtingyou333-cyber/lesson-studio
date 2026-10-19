import {state,command,signedIn,message,type StudioState} from '../../utils/api';
type ClassView=StudioState['classes'][number]&{memberNames:string};
type Choice=StudioState['students'][number]&{selected:boolean};
Page({
  data:{ready:false,owner:false,error:'',busy:false,editing:false,showArchived:false,classes:[] as ClassView[],visibleClasses:[] as ClassView[],courses:[] as StudioState['courses'],teachers:[] as StudioState['teachers'],students:[] as Choice[],rooms:[] as (StudioState['rooms'][number]&{label:string})[],roomIndex:0,courseIndex:0,teacherIndex:0,id:'',version:0,name:'',room:'',capacity:'6',studentIds:[] as string[]},
  async onShow(){this.setData({ready:false,editing:false});if(!signedIn())return;await this.refresh();},
  async refresh(){try{const s=await state();const classes=s.classes.map(c=>({...c,memberNames:c.member_ids.map(id=>s.students.find(s=>s.id===id)?.name||'已归档学员').join('、')}));this.setData({ready:true,error:'',owner:s.actor.role==='owner',classes,visibleClasses:classes.filter(c=>this.data.showArchived||c.active),courses:s.courses.map(c=>({...c,name:c.name+(c.active?'':'（已归档）')})),teachers:s.teachers,rooms:s.rooms.map(r=>({...r,label:r.name+(r.active?'':'（已停用）')})),students:s.students.map(s=>({...s,selected:false}))});}catch(e){this.setData({ready:false,error:message(e)});}},
  archiveFilter(){this.setData({showArchived:!this.data.showArchived,visibleClasses:this.data.classes.filter(c=>!this.data.showArchived||c.active)});},
  edit(e:WechatMiniprogram.TouchEvent){const c=this.data.classes.find(c=>c.id===e.currentTarget.dataset.id);this.setData({editing:true,error:'',id:c?.id||'',version:c?.version||0,name:c?.name||'',room:c?.room||'',roomIndex:c?this.data.rooms.findIndex(r=>r.id===c.room_id):this.data.rooms.findIndex(r=>r.active),capacity:String(c?.capacity||6),courseIndex:Math.max(0,this.data.courses.findIndex(x=>x.id===c?.course_id)),teacherIndex:Math.max(0,this.data.teachers.findIndex(x=>x.id===c?.teacher_id)),studentIds:c?.member_ids||[],students:this.data.students.map(s=>({...s,selected:!!c?.member_ids.includes(s.id)}))});wx.pageScrollTo({scrollTop:0});},
  close(){this.setData({editing:false});},
  pick(e:WechatMiniprogram.PickerChange){this.setData({[e.currentTarget.dataset.key]:Number(e.detail.value)});},
  members(e:WechatMiniprogram.CheckboxGroupChange){this.setData({studentIds:e.detail.value,students:this.data.students.map(s=>({...s,selected:e.detail.value.includes(s.id)}))});},
  async save(e:WechatMiniprogram.FormSubmit){
    if(this.data.busy)return;this.setData({busy:true,error:''});
    try{const course=this.data.courses[this.data.courseIndex],teacher=this.data.teachers[this.data.teacherIndex];const room=this.data.rooms[this.data.roomIndex];if(!course||!teacher||!room?.active)throw new Error('请先设置可用课程、授课老师和教室');
      const v=e.detail.value;
      await command('class_save',{...(this.data.id?{id:this.data.id,expectedVersion:this.data.version}:{}),name:v.name,roomId:room.id,capacity:Number(v.capacity),courseId:course.id,teacherId:teacher.id,studentIds:this.data.studentIds});
      this.setData({editing:false});await this.refresh();wx.showToast({title:'班级已保存'});
    }catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}
  },
  async setActive(e:WechatMiniprogram.TouchEvent){
    if(this.data.busy)return;const c=this.data.classes.find(c=>c.id===e.currentTarget.dataset.id)!;
    const confirmation=await wx.showModal({title:c.active?'归档班级':'恢复班级',content:c.active?'归档后不能继续排新课；已经排好的课程、预约和历史记录全部保留。':'恢复后可继续维护名单和安排新课。'});
    if(!confirmation.confirm)return;this.setData({busy:true,error:''});
    try{await command('class_active',{classId:c.id,expectedVersion:c.version,active:!c.active});await this.refresh();}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}
  },
  schedule(e:WechatMiniprogram.TouchEvent){wx.navigateTo({url:'/pages/series/index?classId='+e.currentTarget.dataset.id});},
});
