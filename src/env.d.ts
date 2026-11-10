import 'vite/client'
import type { Node } from '@tiptap/pm/model'
import type { MarkdownStorage } from 'tiptap-markdown'

declare module '@tiptap/core' {
    interface Storage {
        markdown?: MarkdownStorage & { serializer: { serialize: (content: Node) => string } }
    }
}
