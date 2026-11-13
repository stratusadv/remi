export type MenuIconName =
    | 'add'
    | 'ask'
    | 'close'
    | 'copy'
    | 'delete'
    | 'edit'
    | 'folder'
    | 'open'
    | 'pause'
    | 'person'
    | 'play'
    | 'retry'
    | 'settings'
    | 'sparkles'
    | 'star'

export interface MenuItem {
    id: string
    label: string
    icon: MenuIconName
    danger?: boolean
}

export const ICON_PATH_BUBBLE = 'M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 '
    + '3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494'
    + 'c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228'
    + 'A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513'
    + 'C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z'

export const ICON_PATH_FOLDER = 'M3.75 6.75a1.5 1.5 0 0 1 1.5-1.5h4.19a1.5 1.5 0 0 1 1.06.44'
    + 'l1.56 1.56h6.69a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5Z'

export const ICON_PATH_GEAR = 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94'
    + 'l.213 1.281c.063.374.313.686.65.83a6.748 6.748 0 0 1 1.124.65c.317.234.715.298 1.067.156'
    + 'l1.213-.485a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431'
    + 'l-1.003.827'
    + 'c-.293.241-.438.613-.43.992.014.418.014.838 0 1.255-.008.378.137.75.43.991'
    + 'l1.004.828a1.125 1.125 0 0 1 .26 1.431l-1.298 2.247a1.125 1.125 0 0 1-1.37.491'
    + 'l-1.213-.486c-.352-.141-.75-.077-1.066.158a6.81 6.81 0 0 1-1.125.65'
    + 'c-.337.144-.587.456-.65.83l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594'
    + 'c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.65-.83'
    + 'a6.749 6.749 0 0 1-1.125-.65c-.317-.235-.715-.299-1.067-.158l-1.213.486'
    + 'a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.432l1.004-.827'
    + 'c.292-.241.437-.613.43-.992a7.07 7.07 0 0 1 0-1.255c.007-.378-.138-.75-.43-.991'
    + 'l-1.004-.828a1.125 1.125 0 0 1-.26-1.431l1.297-2.247a1.125 1.125 0 0 1 1.37-.491'
    + 'l1.212.486'
    + 'c.352.142.75.078 1.067-.157.347-.26.722-.479 1.125-.65.337-.144.587-.456.65-.83'
    + 'l.214-1.28Z'

export const ICON_PATH_PERSON_BODY = 'M4.5 20.25a7.5 7.5 0 0 1 15 0v.75h-15v-.75Z'
export const ICON_PATH_PERSON_HEAD = 'M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z'

const ICON_PATH_PEN = 'M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82'
    + 'a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z'

const ICON_PATH_PLAY = 'M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5Z'

const ICON_PATH_SPARKLE_LARGE = 'M9.813 15.904 9 18.75l-.813-2.846'
    + 'a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25'
    + 'l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z'

const ICON_PATH_SPARKLE_SMALL = 'M18.259 8.715 18 9.75l-.259-1.035'
    + 'a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456'
    + 'L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259'
    + 'a3.375 3.375 0 0 0-2.456 2.456Z'

const ICON_PATH_SPARKLE_TINY = 'M16.894 20.567 16.5 21.75l-.394-1.183'
    + 'a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423'
    + 'l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394'
    + 'a2.25 2.25 0 0 0-1.423 1.423Z'

const ICON_PATH_STAR = 'M11.48 3.5a.56.56 0 0 1 1.04 0l2.12 5.11a.56.56 0 0 0 .48.35l5.52.44'
    + 'c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.56l1.28 5.39a.56.56 0 0 1-.84.61'
    + 'l-4.73-2.89a.56.56 0 0 0-.58 0l-4.73 2.89a.56.56 0 0 1-.84-.61l1.28-5.39'
    + 'a.56.56 0 0 0-.18-.56l-4.2-3.6a.56.56 0 0 1 .32-.99l5.52-.44a.56.56 0 0 0 .48-.35'
    + 'L11.48 3.5Z'

export const MENU_ICON_PATHS: Readonly<Record<MenuIconName, readonly string[]>> = Object.freeze({
    add: ['M12 5.25v13.5', 'M5.25 12h13.5'],
    ask: ['M7.5 8.25h9', 'M7.5 11.25H12', ICON_PATH_BUBBLE],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    copy: ['M8.25 8.25h10.5v10.5H8.25Z', 'M15.75 8.25v-3H5.25v10.5h3'],
    delete: [
        'M4.5 6.75h15',
        'M9.75 6.75V4.5h4.5v2.25',
        'M6.75 6.75l.75 12.75h9l.75-12.75',
        'M10.5 10.5v5.25',
        'M13.5 10.5v5.25',
    ],
    edit: [ICON_PATH_PEN, 'M16.862 4.487 19.5 7.125'],
    folder: [ICON_PATH_FOLDER],
    open: ['M7.5 16.5l9-9', 'M9.75 7.5h6.75v6.75'],
    pause: ['M8.25 5.25v13.5', 'M15.75 5.25v13.5'],
    person: [ICON_PATH_PERSON_HEAD, ICON_PATH_PERSON_BODY],
    play: [ICON_PATH_PLAY],
    retry: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4.5H15'],
    settings: [ICON_PATH_GEAR, 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
    sparkles: [ICON_PATH_SPARKLE_LARGE, ICON_PATH_SPARKLE_SMALL, ICON_PATH_SPARKLE_TINY],
    star: [ICON_PATH_STAR],
})

export const MENU_ITEM_ASK = Object.freeze<MenuItem>({
    id: 'ask',
    label: 'Ask about this meeting',
    icon: 'ask',
})

export const MENU_ITEM_ASK_FOLDER = Object.freeze<MenuItem>({
    id: 'ask',
    label: 'Ask about this folder',
    icon: 'ask',
})

export const MENU_ITEM_COPY = Object.freeze<MenuItem>({ id: 'copy', label: 'Copy', icon: 'copy' })

export const MENU_ITEM_DELETE = Object.freeze<MenuItem>({
    id: 'delete',
    label: 'Delete',
    icon: 'delete',
    danger: true,
})

export const MENU_ITEM_MOVE = Object.freeze<MenuItem>({
    id: 'move',
    label: 'Move to folder',
    icon: 'folder',
})

export const MENU_ITEM_OPEN_MEETING = Object.freeze<MenuItem>({
    id: 'open',
    label: 'Open meeting',
    icon: 'open',
})

export const MENU_ITEM_RENAME = Object.freeze<MenuItem>({
    id: 'rename',
    label: 'Rename',
    icon: 'edit',
})
