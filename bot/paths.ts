// Where kantoku bot keeps its own files inside each manager's home. One place,
// so a rename or move cannot miss a copy.
import { join } from 'node:path'

export const BOT_DIR = 'bot'
export const LOG_FILE = join(BOT_DIR, 'from-user.jsonl')
export const HANDLED_FILE = join(BOT_DIR, 'handled.txt')
export const BACKUP_DIR = join(BOT_DIR, 'backup')
export const SECRET_REQUESTS_FILE = join(BOT_DIR, 'secret-requests.jsonl')
