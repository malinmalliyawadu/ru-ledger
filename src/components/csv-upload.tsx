'use client'

import { useActionState, useRef, useState } from 'react'

import { importStatement, type ImportState } from '../app/actions.ts'
import { fullDate, plural } from '../lib/format.ts'

const INITIAL: ImportState = { status: 'idle' }

/**
 * Statement upload, for any account Akahu cannot reach — a store card, or a
 * bank it has no integration with.
 *
 * The alternative was copying a file onto the server by hand every month, which
 * is the kind of friction that means the import quietly stops happening. That
 * matters more than it sounds: a missing statement understates spending rather
 * than failing outright, because the payment settling those purchases is
 * excluded either way.
 */
export function CsvUpload() {
  const [state, submit, pending] = useActionState(importStatement, INITIAL)
  const [filename, setFilename] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const choose = (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    if (inputRef.current) {
      const transfer = new DataTransfer()
      transfer.items.add(file)
      inputRef.current.files = transfer.files
    }
    setFilename(file.name)
  }

  return (
    <form action={submit} ref={formRef}>
      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}${pending ? ' is-busy' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          choose(event.dataTransfer.files)
        }}
      >
        <input
          ref={inputRef}
          id="file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          className="visually-hidden"
          onChange={(event) => choose(event.target.files)}
        />

        <label htmlFor="file" className="dropzone-label">
          <strong>{filename ?? 'Drop the statement CSV here'}</strong>
          <span>{filename ? 'Ready to import' : 'or choose a file'}</span>
        </label>

        <button className="btn" type="submit" disabled={pending || !filename}>
          {pending ? 'Importing…' : 'Import statement'}
        </button>
      </div>

      {state.status === 'error' && (
        <div className="banner banner-error" role="alert" style={{ marginTop: 12 }}>
          <svg className="banner-icon" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.2" />
            <circle cx="12" cy="16.2" r="0.6" fill="currentColor" stroke="none" />
          </svg>
          <div>
            <strong>That file could not be imported.</strong> {state.message}
          </div>
        </div>
      )}

      {state.status === 'done' && (
        <div className="banner banner-ok" role="status" style={{ marginTop: 12 }}>
          <svg className="banner-icon" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="m8 12.2 2.8 2.8L16 9.6" />
          </svg>
          <div>
            <strong>
              {state.inserted === 0
                ? 'Already up to date.'
                : `Imported ${plural(state.inserted, 'transaction')}.`}
            </strong>{' '}
            {state.filename} held {plural(state.rowsInFile, 'row')} covering{' '}
            {fullDate(state.from)} to {fullDate(state.to)}
            {state.alreadyPresent > 0 && `, of which ${state.alreadyPresent} were already here`}.
            Everything is reclassified: {(state.coverage * 100).toFixed(2)}% categorised
            {state.unmatched > 0 && `, ${state.unmatched} still unmatched`}.
          </div>
        </div>
      )}
    </form>
  )
}
