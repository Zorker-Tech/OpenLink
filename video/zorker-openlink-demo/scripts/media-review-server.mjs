// Local artifact preview with HTTP byte ranges for high-frame-rate MP4 seeking.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const base=path.resolve(process.argv[2]||'out/white-120'),port=Number(process.argv[3]||3128);
const types={'.html':'text/html; charset=utf-8','.mp4':'video/mp4','.png':'image/png','.jpg':'image/jpeg','.json':'application/json'};
http.createServer((req,res)=>{
 try{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(base,'.'+name);
  if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const size=fs.statSync(file).size;let start=0,end=size-1,status=200;
  const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'');
  if(match){status=206;if(!match[1])start=Math.max(0,size-Number(match[2]));else start=Number(match[1]);if(match[1]&&match[2])end=Math.min(end,Number(match[2]));if(start> end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}}
  const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'no-cache'};
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  res.writeHead(status,headers);if(req.method==='HEAD'){res.end();return;}
  const stream=fs.createReadStream(file,{start,end});stream.pipe(res);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());
 }catch{res.writeHead(400);res.end();}
}).listen(port,'127.0.0.1',()=>console.log(`Media review: http://127.0.0.1:${port}`));
