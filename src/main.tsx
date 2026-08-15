import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载节点')
}

createRoot(container).render(
  <StrictMode>
    <div>MeshMind</div>
  </StrictMode>,
)
