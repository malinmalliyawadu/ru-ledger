import { NextResponse, type NextRequest } from 'next/server'

import { SESSION_COOKIE, isProtected, isValidSession } from './lib/auth.ts'

/**
 * The gate.
 *
 * Everything the app serves goes through here, which is the point: page
 * requests, server action POSTs, and the RSC payloads the router fetches when
 * you click a link all arrive as ordinary requests to a route, so gating routes
 * gates the lot. Nothing else in the app has to remember to check.
 */
export async function middleware(request: NextRequest) {
  if (!isProtected()) return NextResponse.next()

  const { pathname, search } = request.nextUrl

  if (pathname === '/login') return NextResponse.next()

  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next()
  }

  const login = new URL('/login', request.url)
  if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`)

  // A server action is a POST the browser made from a page it already had, so
  // redirecting it would replay the action against the login page. Answer with
  // a plain 401 instead and let the next navigation land on the form.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new NextResponse('Signed out', { status: 401 })
  }

  return NextResponse.redirect(login)
}

export const config = {
  // Static assets and the font files Next serves alongside them are not worth
  // gating: they carry no ledger data, and running crypto on every one of them
  // would be a cost paid on every page load.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
}
