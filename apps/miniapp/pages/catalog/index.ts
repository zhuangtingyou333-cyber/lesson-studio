import {state,message,units,type StudioState} from '../../utils/api';
Page({
  data:{error:'',owner:false,showArchived:false,courses:[] as StudioState['courses'],packages:[] as object[],rooms:[] as StudioState['rooms']},
  async onShow(){this.setData({owner:false});await this.refresh();},
  async refresh(){try{const s=await state();this.setData({error:'',owner:s.actor.role==='owner',courses:s.courses,rooms:s.rooms,packages:s.packages.map(p=>({...p,quantity:units(p.purchased),bonus:units(p.gift),amount:(p.price/100).toFixed(2),courseName:s.courses.find(c=>c.id===p.course_id)?.name}))});}catch(e){this.setData({error:message(e)});}},
  filter(){this.setData({showArchived:!this.data.showArchived});},
  edit(e:WechatMiniprogram.TouchEvent){wx.navigateTo({url:'/pages/resource/index?kind='+e.currentTarget.dataset.kind+'&id='+(e.currentTarget.dataset.id||'')});},
});
