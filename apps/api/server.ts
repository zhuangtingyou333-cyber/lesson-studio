import 'reflect-metadata';
import {z} from 'zod';
import { Body, Catch, Controller, Get, Headers, Inject, Module, Post, Req, Res, Param, Query, UseFilters, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import {json} from 'express';
import {csv} from './imports/parse.ts';
import {importHeaders} from './imports/service.ts';
import { randomUUID } from 'node:crypto';
import { StudioService, digest } from './service.ts';
import { DomainError, ensure } from './errors.ts';
import type { Command } from './schemas.ts';
import type { Actor } from '../../packages/contracts/index.ts';

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const res=host.switchToHttp().getResponse<Response>();
    const requestId=randomUUID();
    if(error instanceof DomainError) return res.status(error.status).json({code:error.code,message:error.message,details:error.details,requestId});
    if(error?.type==='entity.too.large')return res.status(413).json({code:'IMPORT_LIMIT',message:'请求过大，请使用2MB以内文件',requestId});
    if(error?.getStatus?.()===400||error?.status===400) return res.status(400).json({code:'VALIDATION',message:'请求格式不正确',requestId});
    console.error('Request failed',requestId,error?.message);
    res.status(500).json({code:'INTERNAL',message:'操作未完成，请刷新核对后重试',requestId});
  }
}
@Controller('api')
@UseFilters(ErrorFilter)
class StudioController {
  constructor(@Inject(StudioService) private service:StudioService){}
  private token(req:Request){return req.headers.authorization?.replace(/^Bearer /,'')??req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('studio_session='))?.slice(15)??'';}
  private actor(req:Request){return this.service.auth(this.token(req));}
  @Get('health') health(){return {status:'ok',mode:'local-development',version:'0.1.0'};}
  @Post('dev-login') async login(@Body()body:any,@Res()res:Response){
    ensure(['owner','teacher','guardian'].includes(body?.role),'VALIDATION','请选择体验身份');
    const token=await this.service.login(body.role as Actor['role']);
    res.cookie('studio_session',token,{httpOnly:true,sameSite:'strict',maxAge:12*3600000,path:'/'});
    const actor=await this.service.auth(token);
    res.json({token,identityToken:await this.service.identity.issue(actor.userId,null),context:{userId:actor.userId,tenantId:actor.tenantId},mode:'local-development'});
  }
  @Get('auth/options') options(){return {wechatLogin:!!this.service.identity.provider,demoLogin:this.service.identity.demoEnabled};}
  @Post('auth/wechat') wechat(@Body()body:unknown){return this.service.identity.wechatLogin(body);}
  @Post('dev-identity') visitor(@Body()body:unknown){
    const p=z.object({persona:z.enum(['visitor','visitor2'])}).strict().safeParse(body);ensure(p.success,'VALIDATION','请选择新成员体验身份');return this.service.identity.devVisitor(p.data.persona);
  }
  @Get('identity') async identity(@Req()req:Request){return this.service.identity.overview(await this.service.identity.principal(this.token(req)));}
  @Post('identity/select') async select(@Req()req:Request,@Body()body:unknown){
    const p=z.object({tenantId:z.string().min(1).max(100)}).strict().safeParse(body);ensure(p.success,'VALIDATION','请选择机构');
    return this.service.identity.select(await this.service.identity.principal(this.token(req)),p.data.tenantId);
  }
  @Post('identity/commands') async identityCommand(@Req()req:Request,@Body()body:any,@Headers('idempotency-key')key:string){
    ensure(body&&typeof body.operation==='string','VALIDATION','请选择操作');
    return this.service.identity.command(await this.service.identity.principal(this.token(req)),body.operation,body.input,key);
  }
  @Get('members') async members(@Req()req:Request){return this.service.members(await this.actor(req));}
  @Post('logout') async logout(@Req()req:Request,@Res()res:Response){
    await this.service.db.query('DELETE FROM auth_sessions WHERE token_hash=$1',[digest(this.token(req))]);
    res.clearCookie('studio_session',{path:'/'});res.json({ok:true});
  }
  @Get('state') async state(@Req()req:Request){return this.service.snapshot(await this.actor(req));}
  @Post('schedule-preview') async schedulePreview(@Req()req:Request,@Body()body:unknown){return this.service.schedulePreview(await this.actor(req),body);}
  @Post('schedule-change-preview') async scheduleChangePreview(@Req()req:Request,@Body()body:unknown){return this.service.scheduleChangePreview(await this.actor(req),body);}
  @Post('commands') async command(@Req()req:Request,@Body()body:any,@Headers('idempotency-key')key:string){
    ensure(body&&typeof body.operation==='string','VALIDATION','请选择操作');
    return this.service.command(await this.actor(req),body.operation as Command,body.input,key);
  }
  @Get('payroll-month') async payrollMonth(@Req()req:Request,@Query('teacherId')teacherId:string,@Query('month')month:string){return this.service.payrollMonth(await this.actor(req),{teacherId,month});}
  @Get('payroll') async payroll(@Req()req:Request,@Query('cursor')cursor?:string){
    ensure(!cursor||/^\d{1,18}$/.test(cursor),'VALIDATION','分页位置无效');return this.service.payroll(await this.actor(req),'list','',1,cursor);
  }
  @Get('payroll/:id/report.csv') async payrollReport(@Req()req:Request,@Param('id')id:string,@Res()res:Response){
    res.type('text/csv; charset=utf-8').send(await this.service.payroll(await this.actor(req),'report',id));
  }
  @Get('payroll/:id') async payrollDetail(@Req()req:Request,@Param('id')id:string,@Query('page')page='1'){
    ensure(/^[1-9]\d{0,5}$/.test(page),'VALIDATION','页码无效');return this.service.payroll(await this.actor(req),'detail',id,Number(page));
  }
  @Get('imports') async imports(@Req()req:Request,@Query('cursor')cursor?:string){
    ensure(!cursor||/^\d{1,18}$/.test(cursor),'VALIDATION','分页位置无效');return this.service.imports(await this.actor(req),'list','',1,cursor);
  }
  @Get('import-template.csv') async importTemplate(@Req()req:Request,@Res()res:Response){
    const a=await this.actor(req);ensure(a.role==='owner','FORBIDDEN','只有管理员可以获取模板',403);res.type('text/csv; charset=utf-8').send(csv([importHeaders]));
  }
  @Get('imports/:id/report.csv') async importReport(@Req()req:Request,@Param('id')id:string,@Res()res:Response){
    res.type('text/csv; charset=utf-8').send(await this.service.imports(await this.actor(req),'report',id));
  }
  @Get('imports/:id') async importDetail(@Req()req:Request,@Param('id')id:string,@Query('page')page='1'){
    ensure(/^[1-9]\d{0,4}$/.test(page),'VALIDATION','页码无效');return this.service.imports(await this.actor(req),'detail',id,Number(page));
  }
  @Get('ledger.csv') async ledger(@Req()req:Request,@Res()res:Response){
    const content=await this.service.exportLedger(await this.actor(req));
    res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',"attachment; filename=lesson-ledger.csv");res.send(content);
  }
}
export async function createApp(service:StudioService) {
  @Module({controllers:[StudioController],providers:[{provide:StudioService,useValue:service}]}) class AppModule{}
  const app=await NestFactory.create(AppModule,{logger:['error','warn'],bodyParser:false});
  // This build intentionally cannot be used as a public deployment with demo sign-in.
  app.use((req:Request,res:Response,next:()=>void)=>{
    const host=(req.headers.host??'').split(':')[0];
    if(!['127.0.0.1','localhost'].includes(host))return res.status(403).json({code:'LOCAL_ONLY',message:'当前为本机开发版本'});
    const origin=req.headers.origin;
    if(origin){try{if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))return res.status(403).json({code:'ORIGIN_DENIED',message:'请求来源不匹配'});}catch{return res.sendStatus(403);}}
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');next();
  });
  app.use(json({limit:'3mb'}));
  app.use((error:any,_req:Request,res:Response,next:NextFunction)=>{
    if(error?.type==='entity.too.large')return res.status(413).json({code:'IMPORT_LIMIT',message:'请求过大，请使用2MB以内文件'});
    if(error?.status===400)return res.status(400).json({code:'VALIDATION',message:'请求格式不正确'});
    next(error);
  });
  return app;
}
