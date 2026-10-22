/**
 * Recovering a conversation whose records and files disagree.
 *
 * A scan compares what the transcript says an agent's profile and settings are with what is on disk and writes the
 * missing files, so an agent that was recovered still has the identity it was described by; a scan that cannot read
 * the records says what it could not do rather than reporting an empty recovery.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getSlateProfilePath, writeSlateProfileFile } from "../../agents/agent-profile.ts";
import { getSlateSettingsPath, writeAgentSettings } from "../../agents/settings-file.ts";
export class ConversationRecoveryScanError extends Error{constructor(readonly detail:string){super(`conversation recovery scan failed: ${detail}`);this.name="ConversationRecoveryScanError"}}
export function transcriptEntryMatchesRecovered(a:Record<string,unknown>,b:Record<string,unknown>):boolean{if(a.kind!==b.kind)return false;if(a.kind==="message")return a.role===b.role&&a.content===b.content;if(a.kind==="send-message")return isDeepStrictEqual(a.message,b.message);if(a.kind==="tool-call")return a.name===b.name&&a.status===b.status&&a.summary===b.summary;return false}
export function cacheBlobReads<T>(store:{getBlob(ctx:unknown,id:Uint8Array):Promise<T|null>;setBlob(ctx:unknown,id:Uint8Array,data:T):Promise<void>;flush(ctx:unknown):Promise<void>}){const reads=new Map<string,Promise<T|null>>(),key=(id:Uint8Array)=>Buffer.from(id).toString("hex");return{getBlob(ctx:unknown,id:Uint8Array){const k=key(id),cached=reads.get(k);if(cached)return cached;const read=store.getBlob(ctx,id);reads.set(k,read);return read},setBlob(ctx:unknown,id:Uint8Array,data:T){reads.set(key(id),Promise.resolve(data));return store.setBlob(ctx,id,data)},flush:(ctx:unknown)=>store.flush(ctx)}}
export function ensureProfileFile(dbPath:string,db:{get(key:string):unknown;getSlateProfile?():{description?:string}}):string{const path=getSlateProfilePath(dirname(dbPath));if(existsSync(path))return path;writeSlateProfileFile(path,{name:String(db.get("name")||"Slate").trim()||"Slate",description:db.getSlateProfile?.().description?.trim()??"",title:"",avatarShape:"",avatarColor:""});return path}
export function ensureSettingsFile(dbPath:string):string{const path=getSlateSettingsPath(dirname(dbPath));if(!existsSync(path))writeAgentSettings(path,{});return path}
