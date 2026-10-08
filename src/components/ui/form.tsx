import {
  cloneElement, forwardRef, isValidElement, useId,
  type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@/lib/utils'

const controlBase =
  'block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset ' +
  'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-slate-500'

interface FieldProps {
  label: string
  error?: string | undefined
  hint?: string
  required?: boolean
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>
  className?: string
}

/** Label + control + message wiring (accessible: label/for, aria-invalid, aria-describedby). */
export function Field({ label, error, hint, required, children, className }: FieldProps) {
  const id = useId()
  const msgId = `${id}-msg`
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error || hint ? msgId : undefined,
      })
    : children
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-red-600" aria-hidden> *</span>}
      </label>
      {control}
      {(error || hint) && (
        <p id={msgId} role={error ? 'alert' : undefined} className={cn('mt-1 text-xs', error ? 'text-red-600' : 'text-slate-500')}>
          {error ?? hint}
        </p>
      )}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest }, ref,
) {
  return (
    <input
      ref={ref}
      className={cn(controlBase, rest['aria-invalid'] ? 'ring-red-400' : 'ring-slate-300', className)}
      {...rest}
    />
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 3, ...rest }, ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(controlBase, rest['aria-invalid'] ? 'ring-red-400' : 'ring-slate-300', className)}
      {...rest}
    />
  )
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest }, ref,
) {
  return (
    <select
      ref={ref}
      className={cn(controlBase, 'pr-8', rest['aria-invalid'] ? 'ring-red-400' : 'ring-slate-300', className)}
      {...rest}
    >
      {children}
    </select>
  )
})

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <input id={id} type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" {...rest} />
      <label htmlFor={id} className="text-sm text-slate-700">{label}</label>
    </div>
  )
}

/** Native date control, styled; value is an ISO date (yyyy-mm-dd). */
export const DateInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function DateInput(props, ref) {
  return <Input ref={ref} type="date" {...props} />
})
