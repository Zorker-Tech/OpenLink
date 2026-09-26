/**
 * Telling an agent that its own profile changed.
 *
 * The update is a marked block the agent's prompt can carry, holding the profile section and the identity it was
 * written for, so a later run can tell whether the prompt it is looking at already has the current profile. The newest
 * update in a transcript is the one that counts, and an identity is compared by its trimmed name and description.
 */
import{Buffer}from"node:buffer";import{SLATE_HIDDEN_PROMPT_MARKER}from"./slate-prompt-markers.ts";
export const SLATE_AGENT_PROFILE_UPDATE_MARKER="<<SLATE_AGENT_PROFILE_UPDATE:v1:";
export interface AgentProfileIdentity{readonly name:string;readonly description:string}
export interface AgentProfilePromptSnapshot{readonly version:1;readonly profileSection:string;readonly systemIdentity:AgentProfileIdentity;readonly announcedIdentity:AgentProfileIdentity;readonly compactionEpoch:number}
export const normalizeAgentProfileIdentity=(p:AgentProfileIdentity):AgentProfileIdentity=>({name:p.name.trim(),description:p.description.trim()});
export const agentProfileIdentitiesEqual=(a:AgentProfileIdentity,b:AgentProfileIdentity):boolean=>a.name===b.name&&a.description===b.description;
export function resolveAgentProfilePromptSnapshot(a:{snapshot?:AgentProfilePromptSnapshot;compactionEpoch:number;profileSection:string;identity:AgentProfileIdentity}):AgentProfilePromptSnapshot{return a.snapshot?.compactionEpoch===a.compactionEpoch?a.snapshot:{version:1,profileSection:a.profileSection,systemIdentity:a.identity,announcedIdentity:a.identity,compactionEpoch:a.compactionEpoch}}
export function renderAgentProfileUpdate(i:AgentProfileIdentity):string{const encoded=Buffer.from(JSON.stringify(i)).toString("base64url");return[`${SLATE_HIDDEN_PROMPT_MARKER}${SLATE_AGENT_PROFILE_UPDATE_MARKER}${encoded}>>`,"<agent_profile_update>","Your agent profile changed. This full update is authoritative and supersedes the Agent profile section in the system prompt and every earlier profile update in this conversation.",`Current name: ${i.name||"(no name)"}`,`Current description: ${i.description||"(no description)"}`,"Use this identity until a future conversation summary folds it into the Agent profile section.","</agent_profile_update>"].join("\n")}
export function parseLatestAgentProfileUpdate(text:string):AgentProfileIdentity|null{let latest:null|AgentProfileIdentity=null,from=0;for(;;){const at=text.indexOf(SLATE_AGENT_PROFILE_UPDATE_MARKER,from);if(at<0)return latest;const start=at+SLATE_AGENT_PROFILE_UPDATE_MARKER.length,end=text.indexOf(">>",start);if(end<0)return latest;try{const p:unknown=JSON.parse(Buffer.from(text.slice(start,end),"base64url").toString());if(typeof p==="object"&&p!==null&&"name"in p&&typeof p.name==="string"&&"description"in p&&typeof p.description==="string")latest=normalizeAgentProfileIdentity({name:p.name,description:p.description})}catch{}from=end+2}}

