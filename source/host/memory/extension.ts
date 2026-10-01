/** What an agent remembers, wired as a host extension.

 * The memory service is built here, the platform's own gate decides whether remembering is reviewed at all, and the
 * per-agent state a tool writes through is created against the root the host runs under. */
import type { DebouncePolicy } from "../extensions/scheduling.ts";
import { AgentProjectMembership } from "./project-membership.ts";
import { createSlateAgentState, type AgentStateDeps } from "./agent-state.ts";
import { MemoryService } from "./memory-service.ts";
export interface MemoryExtensionContext {
  slateRoot:string;agentsRootDir:string;debounce:DebouncePolicy;
  deps:{experiments:{pinGateOnAuthenticatedBootstrap(name:string,listener:(enabled:boolean)=>void):void};inference:{port:{createSession(onRequestId:(requestId:string)=>void,options:{modelId:string;isSummarizationSession:boolean;skipLabeling:boolean}):{getExecutor():import("../../packages/chat-inference/base.ts").PromptExecutor<Record<string,any>>}}};telemetry:{logs:{reportMemorySynthesis(event:unknown):void}}};
  createSynthesis(service:MemoryService):{start():void;dispose():void;recordTurn?(agentId:string,exchange:unknown):void};
  onStop(fn:()=>void):void;
}
export const memoryExtension={id:"memory",dependencies:["experiments","inference","telemetry"]as const,start(context:MemoryExtensionContext){const service=new MemoryService({slateRoot:context.slateRoot,agentsRootDir:context.agentsRootDir,debounce:context.debounce});context.deps.experiments.pinGateOnAuthenticatedBootstrap("slate_memory_dreaming",(enabled)=>{if(!enabled){context.deps.telemetry.logs.reportMemorySynthesis({outcome:"skipped_gate"});return}service.enableMemorySynthesis(context.createSynthesis(service))});context.onStop(()=>service.dispose());return Object.assign(service,{createAgentState:(options:Omit<AgentStateDeps,"slateRoot"|"membership">&{agentDir:string})=>createSlateAgentState({...options,slateRoot:context.slateRoot,membership:new AgentProjectMembership(options.agentDir)})})}};
