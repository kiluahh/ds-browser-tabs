const api = globalThis.browser ?? globalThis.chrome

const hostInput = document.getElementById('host')
const tokenInput = document.getElementById('token')
const statusEl = document.getElementById('status')

const stored = await api.storage.local.get({ host: 'http://127.0.0.1:3080', token: '' })
hostInput.value = stored.host
tokenInput.value = stored.token

document.getElementById('save').addEventListener('click', async () => {
  await api.storage.local.set({ host: hostInput.value.trim(), token: tokenInput.value.trim() })
  statusEl.textContent = '已保存，正在重连…'
  await refresh()
})

async function refresh() {
  try {
    const answer = await api.runtime.sendMessage({ type: 'status' })
    if (answer?.ok && answer.online) {
      statusEl.textContent = `已连接 · 等待中 ${answer.pending ?? 0} 个请求`
    } else {
      statusEl.textContent = '未连接（DSH 未运行，或地址/令牌不对）'
    }
  } catch {
    statusEl.textContent = '后台未响应，请重新加载扩展'
  }
}

await refresh()
setInterval(refresh, 2_000)
