/**
 * The name a tool call was made under.
 *
 * A model's tool call may be recorded before the platform knows which tool it is, so the name is remembered by the
 * call's id and handed over when the update arrives; both the names and the pending updates are bounded, since a session
 * may see more calls than it ever resolves.
 */
export interface ToolSurfaceUpdate{readonly name?:string;readonly [key:string]:unknown}
export function createToolCallIdentity(host:{emitUpdate(update:ToolSurfaceUpdate):void}){const names=new Map<string,string>(),held=new Map<string,ToolSurfaceUpdate>();const cap=<T>(m:Map<string,T>)=>{if(m.size>=128){const key=m.keys().next().value;if(key!==undefined)m.delete(key)}};return{recordModelToolName(id:string,name:string){cap(names);names.set(id,name);const update=held.get(id);if(update!==undefined){held.delete(id);host.emitUpdate({...update,name})}},resolveModelToolName(event:string,id:string,outline:string){const value=names.get(id);if(event==="toolCallCompleted"){names.delete(id);held.delete(id)}return value??outline},stashSurfaceUnresolvedPending(id:string,update:ToolSurfaceUpdate){cap(held);held.set(id,update)}}}

