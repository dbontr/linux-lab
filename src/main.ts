import './style.css'
import { LinuxLabApp } from './ui/app'

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('Linux Lab root element is missing')

const app = new LinuxLabApp(root)
void app.start()
