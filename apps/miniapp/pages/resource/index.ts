import {state,command,message,type StudioState} from '../../utils/api';
type Kind='student'|'course'|'package'|'room';
const titles={student:'学员档案',course:'课程',package:'课包模板',room:'教室'};
const defaults={name:'',phone:'',note:'',duration:'60',debit:'1',purchased:'10',gift:'0',price:'1000',validDays:'365',capacity:'6',color:'#487969'};
Page({
  data:{kind:'student' as Kind,title:'',id:'',version:0,ready:false,owner:false,busy:false,error:'',result:'',active:true,upcoming:0,draft:{...defaults},courses:[] as (StudioState['courses'][number]&{label:string})[],courseIndex:0},
  onLoad(q:Record<string,string>){const kind=q.kind as Kind;if(!Object.prototype.hasOwnProperty.call(titles,kind)){this.setData({title:'',ready:false,error:'资料类型无效'});return;}this.setData({kind,title:titles[kind],id:q.id||''});},
  async onShow(){if(this.data.title)await this.reload();},
  async reload(){
    this.setData({ready:false,owner:false,error:'',result:''});
    try{const s=await state(),kind=this.data.kind;
      const list=kind==='student'?s.students:kind==='course'?s.courses:kind==='package'?s.packages:s.rooms;
      const item=list.find(x=>x.id===this.data.id) as Record<string,any>|undefined;
      if(this.data.id&&!item)throw new Error('资料不存在或无访问权限');
      const courses=s.courses.filter(c=>c.active||c.id===item?.course_id).map(c=>({...c,label:c.name+(c.active?'':'（已归档）')}));
      const draft={...defaults,...(item?{name:item.name}:{}),...(kind==='student'&&item?{phone:item.phone,note:item.note}:{}),...(kind==='course'&&item?{duration:String(item.duration),debit:String(item.debit/1000),color:item.color}:{}),...(kind==='package'&&item?{purchased:String(item.purchased/1000),gift:String(item.gift/1000),price:String(item.price/100),validDays:String(item.valid_days)}:{}),...(kind==='room'&&item?{capacity:String(item.capacity)}:{})};
      this.setData({ready:true,owner:s.actor.role==='owner',version:item?.version||0,active:item?.active??true,upcoming:item?.upcoming||0,draft,courses,courseIndex:Math.max(0,courses.findIndex(c=>c.id===item?.course_id))});
    }catch(e){this.setData({error:message(e)});}
  },
  input(e:WechatMiniprogram.Input){this.setData({draft:{...this.data.draft,[e.currentTarget.dataset.key]:e.detail.value}});},
  pick(e:WechatMiniprogram.PickerChange){this.setData({courseIndex:Number(e.detail.value)});},
  async save(e:WechatMiniprogram.FormSubmit){
    if(this.data.busy)return;this.setData({busy:true,error:''});
    try{const v=e.detail.value,kind=this.data.kind;
      let input:object={name:v.name};
      if(kind==='student')input={...input,phone:v.phone,note:v.note};
      if(kind==='course')input={...input,duration:Number(v.duration),debit:Math.round(Number(v.debit)*1000),color:this.data.draft.color};
      if(kind==='room')input={...input,capacity:Number(v.capacity)};
      if(kind==='package'){const c=this.data.courses[this.data.courseIndex];if(!c?.active)throw new Error('请先创建或恢复适用课程');input={...input,courseId:c.id,purchased:Math.round(Number(v.purchased)*1000),gift:Math.round(Number(v.gift)*1000),price:Math.round(Number(v.price)*100),validDays:Number(v.validDays)};}
      const r=await command(kind,{...input,...(this.data.id?{id:this.data.id,expectedVersion:this.data.version}:{})}) as {id:string;version:number};
      this.setData({id:r.id,version:r.version,result:v.name+'已保存。已有课次、已开通权益和课时账目保持原样。'});wx.pageScrollTo({scrollTop:0});
    }catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}
  },
  async setActive(){
    if(this.data.busy||!this.data.id)return;
    const descriptions={student:'归档后不能新开课包或新预约。已有预约、点名更正、家长关联和余额保留，不自动退费。',course:'归档后不能新排课、新建班级或开通该课程课包。已有课程和权益仍可使用。',package:'归档后不能继续开通此模板，已开通课包及有效期不变。',room:'停用后不能排新课或增加预约。已有'+this.data.upcoming+'节未结束课程保留，请另行调整教室或取消；不会自动通知学员。'};
    const ok=await wx.showModal({title:this.data.active?(this.data.kind==='room'?'停用教室':'归档'+this.data.title):'恢复'+this.data.title,content:this.data.active?descriptions[this.data.kind]:'恢复后可再次用于新增业务，其他关联资料的状态不变。'});
    if(!ok.confirm)return;this.setData({busy:true,error:''});
    try{await command('resource_active',{kind:this.data.kind,id:this.data.id,expectedVersion:this.data.version,active:!this.data.active});await this.reload();wx.showToast({title:'状态已更新'});}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}
  },
  back(){if(this.data.kind==='student')wx.switchTab({url:'/pages/students/index'});else wx.redirectTo({url:'/pages/catalog/index'});},
});
