import { ArrowUpRight01Icon, Loading03Icon, Tick02Icon, LaptopIcon, Copy01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowReloadHorizontalIcon, MoreHorizontalIcon, Menu01Icon, Globe02Icon, ComputerTerminal01Icon, Cursor02Icon, SmartPhone01Icon, OrientationPotraitToLandscapeIcon, ChevronDownIcon, CookieIcon, CleanIcon, MessageAdd01Icon, ArrowMoveDownLeftIcon, SquareIcon } from '@hugeicons/core-free-icons';
// BB's composer microphone glyph, so the annotation dictation button matches it.
const BbMicIcon: typeof SquareIcon = [
  ['path', { d: 'M17 7V11C17 13.7614 14.7614 16 12 16C9.23858 16 7 13.7614 7 11V7C7 4.23858 9.23858 2 12 2C14.7614 2 17 4.23858 17 7Z', stroke: 'currentColor', strokeWidth: '1.5', key: '0' }],
  ['path', { d: 'M20 11C20 15.4183 16.4183 19 12 19M12 19C7.58172 19 4 15.4183 4 11M12 19V22M12 22H15M12 22H9', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '1' }],
];
export const browserIcons = { External: ArrowUpRight01Icon, Loading: Loading03Icon, Check: Tick02Icon, Machine: LaptopIcon, Copy: Copy01Icon, ArrowLeft: ArrowLeft01Icon, ArrowRight: ArrowRight01Icon, RefreshCw: ArrowReloadHorizontalIcon, More: MoreHorizontalIcon, List: Menu01Icon, Globe: Globe02Icon, Terminal: ComputerTerminal01Icon, Cursor: Cursor02Icon, Responsive: SmartPhone01Icon, Rotate: OrientationPotraitToLandscapeIcon, ChevronDown: ChevronDownIcon, Cookie: CookieIcon, Clean: CleanIcon, Annotate: MessageAdd01Icon, Mic: BbMicIcon, Send: ArrowMoveDownLeftIcon, Stop: SquareIcon };
export type BrowserIconName = keyof typeof browserIcons;
// Only trusted icon-package data is serialized; no page or session strings.
export function browserIconSvg(name: BrowserIconName) {
  const nodes = browserIcons[name].map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).filter(([key]) => key !== 'key').map(([key, value]) => `${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join(' ')} />`).join('');
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" data-icon-library="hugeicons">${nodes}</svg>`;
}
