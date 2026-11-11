import { EMAIL } from '../data/copy'

export type LoginViewProps = {
  emailChars: number
  passwordChars: number
  focus: 'email' | 'password' | null
}

export function LoginView({ emailChars, passwordChars, focus }: LoginViewProps) {
  const email = EMAIL.slice(0, emailChars)
  const password = '•'.repeat(passwordChars)

  return (
    <div className="zbd-rd-login">
      <span aria-hidden="true" className="zbd-rd-avatar" />
      <div className="zbd-rd-fields">
        <div
          className="zbd-rd-field"
          data-zbd-target="portal-email"
          data-focus={focus === 'email' ? 'true' : undefined}
        >
          {email || <span className="zbd-rd-placeholder">Email</span>}
          {focus === 'email' ? <span className="zbd-rd-caret" /> : null}
        </div>
        <div
          className="zbd-rd-field"
          data-zbd-target="portal-password"
          data-focus={focus === 'password' ? 'true' : undefined}
        >
          {password || <span className="zbd-rd-placeholder">Password</span>}
          {focus === 'password' ? <span className="zbd-rd-caret" /> : null}
        </div>
      </div>
      <button className="zbd-rd-submit" data-zbd-target="portal-submit" tabIndex={-1} type="button">
        Sign in
      </button>
    </div>
  )
}
