import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-stone-900">Daari Sentinel</h1>
      <p className="mt-3 text-stone-700">
        Dashcam footage in, road-incident alerts out. Meta models watch the road ahead so drivers
        behind get a reroute-or-stay warning before they reach the scene.
      </p>
      <div className="mt-6">
        <Link
          href="/lab"
          className="inline-block rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          Open the Perception Lab
        </Link>
      </div>
    </main>
  );
}
