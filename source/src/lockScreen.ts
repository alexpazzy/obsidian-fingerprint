import type TouchIDLockPlugin from "./main";
import { verifyPassword } from "./crypto";

export class LockScreen {
	private readonly plugin: TouchIDLockPlugin;
	private overlayEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private passwordInputEl: HTMLInputElement | null = null;
	private touchIdButtonEl: HTMLButtonElement | null = null;
	private busy = false;

	constructor(plugin: TouchIDLockPlugin) {
		this.plugin = plugin;
	}

	get isVisible(): boolean {
		return this.overlayEl !== null;
	}

	show(): void {
		if (this.overlayEl) return;

		const overlay = document.createElement("div");
		overlay.addClass("fingerprint-lock-overlay");

		const card = overlay.createDiv({ cls: "fingerprint-lock-card" });
		card.createDiv({ cls: "fingerprint-lock-icon", text: "\u{1F512}" });
		card.createEl("div", { cls: "fingerprint-lock-title", text: "Vault locked" });
		const status = card.createDiv({ cls: "fingerprint-lock-status", text: "Use Touch ID to continue." });

		const touchIdBtn = card.createEl("button", {
			cls: "mod-cta fingerprint-lock-unlock-btn",
			text: "Unlock with Touch ID",
		});
		touchIdBtn.addEventListener("click", () => void this.attemptTouchID());

		let passwordInput: HTMLInputElement | null = null;
		if (this.plugin.settings.passwordFallbackEnabled && this.plugin.settings.passwordHash) {
			const row = card.createDiv({ cls: "fingerprint-lock-password-row" });
			passwordInput = row.createEl("input", {
				cls: "fingerprint-lock-password-input",
				type: "password",
				placeholder: "Password",
			});
			const submitBtn = row.createEl("button", { text: "Unlock" });
			const submit = () => {
				if (passwordInput) void this.attemptPassword(passwordInput.value);
			};
			submitBtn.addEventListener("click", submit);
			passwordInput.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					submit();
				}
			});
		}

		document.body.appendChild(overlay);
		this.overlayEl = overlay;
		this.statusEl = status;
		this.passwordInputEl = passwordInput;
		this.touchIdButtonEl = touchIdBtn;

		// Swallow keyboard/mouse input outside the overlay while locked, so hotkeys
		// and clicks can't reach the underlying vault while it's supposed to be hidden.
		document.addEventListener("keydown", this.blockOutsideInput, true);
		document.addEventListener("keyup", this.blockOutsideInput, true);
		document.addEventListener("mousedown", this.blockOutsideInput, true);

		void this.attemptTouchID();
	}

	hide(): void {
		if (!this.overlayEl) return;
		this.busy = false;
		document.removeEventListener("keydown", this.blockOutsideInput, true);
		document.removeEventListener("keyup", this.blockOutsideInput, true);
		document.removeEventListener("mousedown", this.blockOutsideInput, true);
		this.overlayEl.remove();
		this.overlayEl = null;
		this.statusEl = null;
		this.passwordInputEl = null;
		this.touchIdButtonEl = null;
	}

	private blockOutsideInput = (evt: Event): void => {
		if (!this.overlayEl) return;
		const target = evt.target as Node | null;
		if (target && this.overlayEl.contains(target)) return;
		evt.stopImmediatePropagation();
		evt.preventDefault();
	};

	private setStatus(text: string, isError = false): void {
		if (!this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass("fingerprint-lock-status-error", isError);
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		if (this.touchIdButtonEl) {
			this.touchIdButtonEl.disabled = busy;
			this.touchIdButtonEl.setText(busy ? "Waiting for Touch ID\u2026" : "Unlock with Touch ID");
		}
	}

	private async attemptTouchID(): Promise<void> {
		if (this.busy) return;
		this.setBusy(true);
		this.setStatus("Waiting for Touch ID\u2026");

		const result = await this.plugin.runTouchIDAuth();
		this.setBusy(false);

		// The vault may have been unlocked another way (e.g. password) while we waited.
		if (!this.overlayEl) return;

		switch (result.status) {
			case "success":
				this.plugin.unlock();
				return;
			case "failed":
				this.setStatus(`Touch ID failed: ${result.message}`, true);
				return;
			case "unavailable":
				this.setStatus(`Touch ID unavailable: ${result.message}`, true);
				return;
			case "not-installed":
				this.setStatus(
					"Native Touch ID helper isn't built yet. Run native/build.sh, or use your password below.",
					true
				);
				return;
		}
	}

	private async attemptPassword(password: string): Promise<void> {
		if (this.busy || !password) return;
		this.setBusy(true);
		const ok = await verifyPassword(
			password,
			this.plugin.settings.passwordSalt,
			this.plugin.settings.passwordHash
		);
		this.setBusy(false);
		if (!this.overlayEl) return;

		if (ok) {
			this.plugin.unlock();
			return;
		}
		this.setStatus("Wrong password.", true);
		if (this.passwordInputEl) {
			this.passwordInputEl.value = "";
			this.passwordInputEl.focus();
		}
	}
}
