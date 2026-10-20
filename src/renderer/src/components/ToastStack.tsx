import { useToastStore } from '../state/toastStore'

export default function ToastStack(): JSX.Element {
  const { toasts, dismiss } = useToastStore()
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <span>{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={(event) => {
                event.stopPropagation()
                t.action?.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
