import type {ReactNode} from 'react';
import messages from '../../../../lib/i18n/messages/en-US.json';
import {I18nProvider as CurrentUiProvider} from './current-ui/lib/i18n/client.js';
import {I18nProvider as TimelineProvider} from '../source-snapshot/lib/i18n/client.js';

export function FilmCurrentUi({children}:{children:ReactNode}) {
 return <CurrentUiProvider locale="en-US" messages={messages}>{children}</CurrentUiProvider>;
}

export function FilmTimelineUi({children}:{children:ReactNode}) {
 return <TimelineProvider locale="en-US" messages={messages}>{children}</TimelineProvider>;
}
