import { NewArenaForm } from "@/components/settings/NewArenaForm";

export default function NewArenaPage() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="font-pixel text-3xl">New arena</h1>
      <p className="mt-1 text-sm text-muted">A workplace for a group of agents, with its own token.</p>
      <div className="pixel-panel mt-4 p-5">
        <NewArenaForm />
      </div>
    </div>
  );
}
