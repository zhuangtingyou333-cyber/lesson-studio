import ExcelJS from 'exceljs';
import {inflateRawSync} from 'node:zlib';
import {ensure,DomainError} from '../errors.ts';
export const MAX_FILE=2*1024*1024,MAX_ROWS=1000,MAX_COLS=30;
export interface Cell {text:string;issue?:string;numeric?:boolean}
export interface SourceRow {line:number;cells:Cell[];hidden?:boolean}
export interface Sheet {name:string;headers:string[];rows:SourceRow[]}
export interface Document {sheets:Sheet[]}
const cell=(text:string,extra:Partial<Cell>={}):Cell=>({text,...extra,...(text.length>2000?{issue:'单元格超过2000字，请在原表中精简'}:{})});

// Check actual inflated lengths before passing this bounded archive to the workbook reader.
export function checkArchive(b:Buffer){
 const max=8*1024*1024;let end=-1;
 for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50&&i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
 ensure(end>=0,'IMPORT_FILE','Excel文件损坏或不是xlsx');
 ensure(b.readUInt16LE(end+4)===0&&b.readUInt16LE(end+6)===0,'IMPORT_FILE','不支持分卷文件');
 const count=b.readUInt16LE(end+10),offset=b.readUInt32LE(end+16);ensure(count>0&&count<=300&&offset<end,'IMPORT_FILE','Excel内容过多或格式不支持');
 let at=offset,total=0;const names=new Set<string>();
 for(let n=0;n<count;n++){
  ensure(at+46<=end&&b.readUInt32LE(at)===0x02014b50,'IMPORT_FILE','Excel目录损坏');
  const flags=b.readUInt16LE(at+8),method=b.readUInt16LE(at+10),packed=b.readUInt32LE(at+20),length=b.readUInt32LE(at+24),nameLen=b.readUInt16LE(at+28),extra=b.readUInt16LE(at+30),comment=b.readUInt16LE(at+32),local=b.readUInt32LE(at+42);
  ensure(at+46+nameLen+extra+comment<=end&&!(flags&1)&&[0,8].includes(method)&&length<=max-total,'IMPORT_FILE','Excel解压内容过大、加密或格式不支持');
  const name=b.subarray(at+46,at+46+nameLen).toString('utf8');ensure(!names.has(name),'IMPORT_FILE','Excel中存在重复文件项');names.add(name);
  ensure(!/vbaProject|externalLinks|embeddings/i.test(name),'IMPORT_FILE','请另存为不含宏、外部链接或嵌入对象的xlsx');
  ensure(local+30<=offset&&b.readUInt32LE(local)===0x04034b50,'IMPORT_FILE','Excel内容损坏');
  const start=local+30+b.readUInt16LE(local+26)+b.readUInt16LE(local+28);ensure(start+packed<=offset,'IMPORT_FILE','Excel内容损坏');
  let raw:Buffer;try{raw=method===0?b.subarray(start,start+packed):inflateRawSync(b.subarray(start,start+packed),{maxOutputLength:max-total+1});}catch{throw new DomainError('IMPORT_FILE','Excel解压失败或内容过大');}
  ensure(raw.length===length&&raw.length<=max-total,'IMPORT_FILE','Excel解压内容过大或长度不匹配');total+=raw.length;at+=46+nameLen+extra+comment;
 }
 ensure(names.has('xl/workbook.xml')&&at===end,'IMPORT_FILE','不支持的Excel结构');
}
function buildSheet(name:string,rows:SourceRow[]):Sheet{
 ensure(rows.length>=1,'IMPORT_EMPTY','文件为空');ensure(rows.length<=MAX_ROWS+1,'IMPORT_LIMIT','每张表最多1000行数据，请拆分文件，不会自动截断');
 const headers=rows[0].cells.map(c=>c.text.trim());ensure(headers.length>0&&headers.length<=MAX_COLS,'IMPORT_LIMIT','最多30列');
 ensure(headers.every(Boolean)&&new Set(headers).size===headers.length&&rows[0].cells.every(c=>!c.issue),'IMPORT_HEADER','首行必须是非空、不重复的文本列名');
 for(const row of rows.slice(1))ensure(row.cells.length<=headers.length,'IMPORT_COLUMNS',`第${row.line}行列数超过表头，可能有未加引号的逗号`);
 return {name,headers,rows:rows.slice(1)};
}
export function parseDelimited(text:string,delimiter=","):Document{
 text=text.replace(/^\uFEFF/,'');ensure(!text.includes('\0'),'IMPORT_FILE','文件含不支持的空字符');
 const rows:SourceRow[]=[];let cells:Cell[]=[],field='',quoted=false,closed=false,line=1,start=1;
 const pushField=()=>{cells.push(cell(field));field='';closed=false;ensure(cells.length<=MAX_COLS,'IMPORT_LIMIT','最多30列');};
 const pushRow=()=>{pushField();rows.push({line:start,cells});cells=[];ensure(rows.length<=MAX_ROWS+1,'IMPORT_LIMIT','每张表最多1000行数据，请拆分文件，不会自动截断');};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else{field+=c;if(c==='\n'||c==='\r'&&text[i+1]!=='\n')line++;}continue;}
  if(c==='"'){ensure(!field&&!closed,'IMPORT_CSV',`第${line}行引号位置不正确`);quoted=true;}
  else if(c===delimiter)pushField();
  else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;pushRow();line++;start=line;}
  else{ensure(!closed,'IMPORT_CSV',`第${line}行引号后出现多余字符`);field+=c;}
 }
 ensure(!quoted,'IMPORT_CSV','CSV引号未闭合');if(field||closed||cells.length)pushRow();
 return {sheets:[buildSheet('表格',rows)]};
}
export async function parseFile(name:string,bytes:Buffer):Promise<Document>{
 ensure(bytes.length>0&&bytes.length<=MAX_FILE,'IMPORT_LIMIT','文件须为2MB以内');const extension=name.split('.').pop()?.toLowerCase();
 if(extension==='csv'||extension==='tsv'){
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new DomainError('IMPORT_ENCODING','请将CSV另存为UTF-8编码，或使用xlsx');}
  return parseDelimited(text,extension==='tsv'?'\t':',');
 }
 ensure(extension==='xlsx','IMPORT_FILE','支持xlsx、UTF-8 CSV与TSV；旧xls请另存为xlsx');checkArchive(bytes);
 const book=new ExcelJS.Workbook();try{await book.xlsx.load(bytes as any);}catch{throw new DomainError('IMPORT_FILE','无法读取Excel，请检查文件是否完整');}
 ensure(book.worksheets.length>0&&book.worksheets.length<=10,'IMPORT_LIMIT','Excel最多10张工作表');const sheets:Sheet[]=[];let expandedText=0;
 for(const sheet of book.worksheets){
  ensure(sheet.rowCount<=MAX_ROWS+1&&sheet.columnCount<=MAX_COLS,'IMPORT_LIMIT',`工作表「${sheet.name}」超过1000行数据或30列，请移除多余区域或拆分`);
  if(!sheet.rowCount)continue;
  const rows:SourceRow[]=[];
  for(let line=1;line<=sheet.rowCount;line++){
   const row=sheet.getRow(line),cells:Cell[]=[];
   for(let c=1;c<=sheet.columnCount;c++){
    const v=row.getCell(c),value=v.value;
    if(v.isMerged){cells.push(cell(v.text,{issue:'合并单元格须先取消合并并补齐值'}));continue;}
    if(v.type===ExcelJS.ValueType.Formula||v.type===ExcelJS.ValueType.Error){cells.push(cell(v.text,{issue:'公式或错误单元格请粘贴为值后重试'}));continue;}
    if(value instanceof Date)cells.push(cell(value.toISOString().slice(0,10)));
    else if(typeof value==='number')cells.push(cell(String(value),{numeric:true}));
    else if(value===null||value===undefined)cells.push(cell(''));
    else if(typeof value==='string')cells.push(cell(value));
    else if(typeof value==='object'&&'richText' in value)cells.push(cell(value.richText.map(x=>x.text).join('')));
    else cells.push(cell(v.text,{issue:'链接或其他特殊单元格请粘贴为纯文本'}));
   }
   expandedText+=cells.reduce((n,c)=>n+Buffer.byteLength(c.text,'utf8'),0);ensure(expandedText<=4*1024*1024,'IMPORT_LIMIT','表格展开后的文本超过4MB，请拆分文件');
   rows.push({line,cells,hidden:!!row.hidden||sheet.state!=='visible'});
  }
  sheets.push(buildSheet(sheet.name,rows));
 }
 ensure(sheets.length,'IMPORT_EMPTY','Excel没有可导入的表格');return {sheets};
}
export const csv=(rows:unknown[][])=>'\uFEFF'+rows.map(row=>row.map(v=>{let s=String(v??'');if(typeof v!=='number'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
