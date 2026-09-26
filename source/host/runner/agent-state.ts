/** The two ways writing an agent's state can end: it was written, or it was not, with the reason. */
export type StateWriteResult<T=unknown>={readonly ok:true;readonly detail:T}|{readonly ok:false;readonly reason:string};
export const stateWriteOk=<T>(detail:T):StateWriteResult<T>=>({ok:true,detail});
export const stateWriteFailed=(reason:string):StateWriteResult<never>=>({ok:false,reason});

