import type {HTMLAttributes} from 'react';
import {clsx} from 'clsx';
import {twMerge} from 'tailwind-merge';
// Source Conversation/ConversationContent classes, minus smooth scroll runtime.
export const Conversation=({className,...props}:HTMLAttributes<HTMLDivElement>)=><div role="log" className={twMerge(clsx('relative flex-1 overflow-y-hidden',className))} {...props}/>;
export const ConversationContent=({className,...props}:HTMLAttributes<HTMLDivElement>)=><div style={{height:'100%',width:'100%',overflow:'auto',scrollbarGutter:'stable both-edges'}}><div className={twMerge(clsx('flex flex-col gap-8 p-4',className))} {...props}/></div>;
