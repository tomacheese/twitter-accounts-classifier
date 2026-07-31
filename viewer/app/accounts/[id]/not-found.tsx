import Link from 'next/link'

/**
 * Rendered when `getAccountDetail` returns `null` for the requested ID.
 * @returns the not-found message for the account detail page
 */
export default function AccountNotFound(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Account not found</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">No account found with that ID.</p>
      <Link href="/accounts" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        ← Back to accounts
      </Link>
    </div>
  )
}
