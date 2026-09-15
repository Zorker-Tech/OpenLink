import {createContext} from 'react';
export const FilmState=createContext({editing:false,pending:false,draft:'',changesOpen:false});
