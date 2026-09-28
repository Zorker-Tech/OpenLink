/**
 * Changing a session's own files.
 *
 * The profile, the avatar and the settings are written where the session keeps them, the avatar cache is invalidated
 * when its picture changes, and removing a session removes everything it kept.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CANONICAL_AVATAR_FILENAME, invalidateAvatarDataUrlCache, listConventionalAvatarFilenames } from "../../agents/agent-avatar.ts";
import { getSlateProfilePath } from "../../agents/agent-profile.ts";
import { agentHasDurableFootprint, buildSummary, loadAgentDbExtras } from "./session-summaries.ts";
import { statIfExists } from "./session-paths.ts";
export interface MutationDb {getSlateProfile():{description:string;avatarPath:string|null};setSlateProfile(value:{description:string;avatarPath:string|null}):boolean;get(key:string):unknown;getTranscriptEntries():Record<string,unknown>[];getUnreadState():{lastActivityAt:number;lastViewedAt:number;isManuallyUnread:boolean;unreadCount:number}}
export async function setAgentAvatarBytes(host:{memory:{agentHasContent(dir:string):boolean}},db:MutationDb,dbPath:string,agentId:string,pngBytes:Uint8Array|null,activeAgentId?:string){const agentDir=dirname(dbPath);for(const name of listConventionalAvatarFilenames(agentDir))await rm(join(agentDir,name),{force:true});if(pngBytes==null){const existing=db.getSlateProfile();if(existing.avatarPath!=null)db.setSlateProfile({description:existing.description,avatarPath:null})}else{await mkdir(agentDir,{recursive:true});await writeFile(join(agentDir,CANONICAL_AVATAR_FILENAME),Buffer.from(pngBytes))}invalidateAvatarDataUrlCache(agentDir);const stats=await statIfExists(dbPath),dbStats=stats==null?undefined:{mtimeMs:Number(stats.mtimeMs)};return await buildSummary({extras:loadAgentDbExtras(db,dbPath,agentId,dbStats),dbPath,dirName:agentId,...(dbStats==null?{}:{dbStats}),...(activeAgentId==null?{}:{activeAgentId}),includeBlank:true,agentHasMemory:(dir)=>host.memory.agentHasContent(dir)})}
export async function recoverAgentWithMissingDb(host:{memory:{agentHasContent(dir:string):boolean};isAgentBeingDeleted(id:string):boolean;hasLiveDbHandle?(path:string):boolean;reseedMinimalStoreDbIfMissing(path:string):void},args:{dbPath:string;dirName:string;activeAgentId?:string}){if(host.isAgentBeingDeleted(args.dirName))return null;const agentDir=dirname(args.dbPath),intact=existsSync(getSlateProfilePath(agentDir))||await agentHasDurableFootprint(agentDir,(dir)=>host.memory.agentHasContent(dir));if(!intact||host.isAgentBeingDeleted(args.dirName))return null;let stats;if(host.hasLiveDbHandle?.(args.dbPath)!==true){host.reseedMinimalStoreDbIfMissing(args.dbPath);stats=await statIfExists(args.dbPath)}const dbStats=stats==null?undefined:{mtimeMs:Number(stats.mtimeMs)};return await buildSummary({extras:null,dbPath:args.dbPath,dirName:args.dirName,...(dbStats==null?{}:{dbStats}),...(args.activeAgentId==null?{}:{activeAgentId:args.activeAgentId}),includeBlank:true,agentHasMemory:(dir)=>host.memory.agentHasContent(dir)})}
