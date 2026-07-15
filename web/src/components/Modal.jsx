import './Modal.css'

export default function Modal({ title, children, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        {title && <div className="modal-title">{title}</div>}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function ConfirmModal({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', confirmDanger = false, onConfirm, onCancel, children }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        {title && <div className="modal-title">{title}</div>}
        <div className="modal-body">
          {message && <p className="modal-message">{message}</p>}
          {children}
        </div>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onCancel}>{cancelLabel}</button>
          <button className={`modal-btn ${confirmDanger ? 'modal-btn-danger' : 'modal-btn-confirm'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

export function InputModal({ title, fields, onSubmit, onCancel, submitLabel = 'Create' }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        {title && <div className="modal-title">{title}</div>}
        <form className="modal-body" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
          {fields}
          <div className="modal-actions">
            <button type="button" className="modal-btn modal-btn-cancel" onClick={onCancel}>Cancel</button>
            <button type="submit" className="modal-btn modal-btn-confirm">{submitLabel}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
