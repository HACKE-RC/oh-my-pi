import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { fmtPercent } from "../../lib/format";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
}

/** Textarea metrics: line-height 22px + 12px top / 4px bottom padding (kept in sync with shell.css). */
const LINE_PX = 22;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

/** Context-window fill in percent, derived from tokens when the host omits `percent`. */
function contextPercent(state: GuestSnapshot["state"]): number | null {
	const usage = state?.contextUsage;
	if (!usage) return null;
	if (usage.percent != null) return usage.percent;
	if (usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0) {
		return (usage.tokens / usage.contextWindow) * 100;
	}
	return null;
}

/** Session vitals under the prompt field: what the next prompt will run on. */
function DockMeta({ state, queued }: { state: GuestSnapshot["state"]; queued: number }): ReactNode {
	const pct = contextPercent(state);
	return (
		<div className="sh-dock-meta">
			{state?.model && (
				<span className="sh-dock-item sh-dock-model" title={`${state.model.provider} · ${state.model.id}`}>
					{state.model.name}
				</span>
			)}
			{state?.thinkingLevel && <span className="sh-dock-item">{state.thinkingLevel}</span>}
			{pct != null && (
				<span
					className={pct > 80 ? "sh-dock-item sh-gauge sh-gauge-warn" : "sh-dock-item sh-gauge"}
					title={`context window · ${fmtPercent(pct)} used`}
				>
					<span className="sh-gauge-track">
						<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
					</span>
					<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
				</span>
			)}
			{queued > 0 && (
				<span className="sh-dock-item sh-queued">
					<span className="sh-queued-label">queued </span>×{queued}
				</span>
			)}
		</div>
	);
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-ask-editor">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<button
				type="button"
				className="sh-btn sh-btn-primary"
				onClick={() => onSubmit(draft)}
				title="submit response"
			>
				<SendHorizontal size={13} /> <span className="sh-btn-label">Submit</span>
			</button>
		</div>
	);
}

export function Composer({ client, snapshot }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working;
	const queued = busy ? (snapshot.state?.queuedMessageCount ?? 0) : 0;
	const canSend = canPrompt && text.trim().length > 0;

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly) return;
		client.sendPrompt(trimmed);
		setText("");
	}, [client, live, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	const stopButton = busy && !readOnly && (
		<button
			type="button"
			className="sh-btn sh-btn-stop"
			onClick={() => client.sendAbort()}
			disabled={!live}
			title="stop the current turn"
		>
			<Square size={11} /> <span className="sh-btn-label">Stop</span>
		</button>
	);

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer">
				<div className="sh-dock sh-dock-ask">
					<div className="sh-ask-head">
						<span className="sh-ask-kicker">host agent asks</span>
						<div className="sh-ask-title">{uiRequest.title}</div>
					</div>
					{uiRequest.kind === "select" ? (
						<div className="sh-ask-options">
							{uiRequest.options.map((option, index) => {
								const label = typeof option === "string" ? option : option.label;
								const checked = uiRequest.checkedIndices?.includes(index) ?? false;
								return (
									<button
										key={`${uiRequest.reqId}-${index}-${label}`}
										type="button"
										className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
										onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
									>
										<span className="sh-ask-option-marker">
											{uiRequest.selectionMarker === "checkbox"
												? checked
													? "☑"
													: "☐"
												: checked
													? "◉"
													: "○"}
										</span>
										<span className="sh-ask-option-copy">
											<span className="sh-ask-option-label">{label}</span>
											{typeof option !== "string" && option.description && (
												<span className="sh-ask-option-description">{option.description}</span>
											)}
										</span>
									</button>
								);
							})}
						</div>
					) : (
						<AskEditor
							key={uiRequest.reqId}
							prefill={uiRequest.prefill}
							onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
						/>
					)}
					<div className="sh-dock-bar">
						<DockMeta state={snapshot.state} queued={queued} />
						<div className="sh-composer-actions">
							<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
								Cancel
							</button>
							{stopButton}
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			<div className={canPrompt ? "sh-dock" : "sh-dock sh-dock-idle"}>
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "read-only link — you're watching this session"
							: live
								? "prompt the host agent…"
								: "waiting for session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-dock-bar">
					<DockMeta state={snapshot.state} queued={queued} />
					<div className="sh-composer-actions">
						{stopButton}
						{!readOnly && (
							<button
								type="button"
								className="sh-btn sh-btn-primary sh-btn-send"
								onClick={send}
								disabled={!canSend}
								title="send (Enter)"
							>
								<SendHorizontal size={13} /> <span className="sh-btn-label">Send</span>
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
