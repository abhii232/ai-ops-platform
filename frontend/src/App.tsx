import { useState, useRef, useEffect } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Message = { role: 'user' | 'assistant'; text: string }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

function App() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', text: 'Hi! How can I help you today?' },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function handleSend(e: FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading) return

    // Previous turns, skipping the greeting
    const history = messages.slice(1)

    setMessages([...messages, { role: 'user', text }])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Request failed')
      setMessages((prev) => [...prev, { role: 'assistant', text: data.reply }])
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: 'Sorry, something went wrong. Please try again.' },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="chat">
      <div className="chat-header">Support Assistant</div>

      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
        {loading && <div className="bubble assistant typing">Typing…</div>}
        <div ref={bottomRef} />
      </div>

      <form className="chat-form" onSubmit={handleSend}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message…"
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

export default App