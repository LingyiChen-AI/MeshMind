// 两个窗口（main / capture）共用同一份前端产物，靠窗口 label 分流渲染。
// 这样打包只有一份 JS，快捕窗口也不需要单独的 HTML 入口。

import { getCurrentWindow } from '@tauri-apps/api/window'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import Capture from './Capture'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载节点')
}

const isCapture = getCurrentWindow().label === 'capture'
document.body.dataset.window = isCapture ? 'capture' : 'main'

createRoot(container).render(
  <StrictMode>{isCapture ? <Capture /> : <App />}</StrictMode>,
)
