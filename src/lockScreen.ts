import type TouchIDLockPlugin from "./main";
import { getBiometricPlatform, isBiometricPlatformSupported } from "./nativeAuth";

export class LockScreen {
	private readonly plugin: TouchIDLockPlugin;
	private overlayEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private passwordInputEl: HTMLInputElement | null = null;
	private biometricButtonEl: HTMLButtonElement | null = null;
	private securityKeyButtonEl: HTMLButtonElement | null = null;
	private busy = false;

	constructor(plugin: TouchIDLockPlugin) {
		this.plugin = plugin;
	}

	get isVisible(): boolean {
		return this.overlayEl !== null;
	}

	private get methodName(): string {
		return this.plugin.biometricMethodName;
	}

	private securityKeysEnabled(): boolean {
		return this.plugin.settings.securityKeyEnabled && this.plugin.settings.securityKeys.length > 0;
	}

	private passwordFallbackAvailable(): boolean {
		return this.plugin.settings.passwordFallbackEnabled && this.plugin.hasFallbackPassword;
	}

	show(): void {
		if (this.overlayEl) return;

		const biometricsSupported = isBiometricPlatformSupported();
		const securityKeys = this.securityKeysEnabled();

		const overlay = createDiv({ cls: "fingerprint-lock-overlay" });

		const card = overlay.createDiv({ cls: "fingerprint-lock-card" });
		card.createDiv({ cls: "fingerprint-lock-icon", text: "\u{1F512}" });
		card.createDiv({ cls: "fingerprint-lock-title", text: "Vault locked" });

		let initialStatus: string;
		if (biometricsSupported) {
			initialStatus = `Use ${this.methodName} to continue.`;
		} else if (securityKeys) {
			initialStatus = "Use your security key to continue.";
		} else {
			initialStatus = "Enter your password to continue.";
		}
		const status = card.createDiv({ cls: "fingerprint-lock-status", text: initialStatus });

		let biometricBtn: HTMLButtonElement | null = null;
		if (biometricsSupported) {
			biometricBtn = card.createEl("button", {
				cls: "mod-cta fingerprint-lock-unlock-btn",
				text: `Unlock with ${this.methodName}`,
			});
			biometricBtn.addEventListener("click", () => void this.attemptBiometric());
		}

		let securityKeyBtn: HTMLButtonElement | null = null;
		if (securityKeys) {
			securityKeyBtn = card.createEl("button", {
				cls: biometricsSupported ? "fingerprint-lock-unlock-btn" : "mod-cta fingerprint-lock-unlock-btn",
				text: "Use security key",
			});
			securityKeyBtn.addEventListener("click", () => void this.attemptSecurityKey());
		}

		let passwordInput: HTMLInputElement | null = null;
		if (this.passwordFallbackAvailable()) {
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
		this.biometricButtonEl = biometricBtn;
		this.securityKeyButtonEl = securityKeyBtn;

		// Swallow keyboard/mouse input outside the overlay while locked, so hotkeys
		// and clicks can't reach the underlying vault while it's supposed to be hidden.
		document.addEventListener("keydown", this.blockOutsideInput, true);
		document.addEventListener("keyup", this.blockOutsideInput, true);
		document.addEventListener("mousedown", this.blockOutsideInput, true);

		if (biometricsSupported) {
			void this.attemptBiometric();
		}
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
		this.biometricButtonEl = null;
		this.securityKeyButtonEl = null;
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

	private setBusy(busy: boolean, waitingText?: string): void {
		this.busy = busy;
		if (this.biometricButtonEl) {
			this.biometricButtonEl.disabled = busy;
			this.biometricButtonEl.setText(
				busy && waitingText ? waitingText : `Unlock with ${this.methodName}`
			);
		}
		if (this.securityKeyButtonEl) {
			this.securityKeyButtonEl.disabled = busy;
		}
	}

	private notInstalledMessage(): string {
		// Only point at the password field when it's actually on screen.
		const fallback = this.passwordFallbackAvailable() ? ", or use your password below" : "";
		if (getBiometricPlatform() === "windows-hello") {
			return (
				"The Windows Hello helper script (native/WindowsHelloAuth.ps1) is missing from the " +
				`plugin folder. Reinstall the plugin${fallback}.`
			);
		}
		return `Native Touch ID helper isn't built yet. Run native/build.sh in the plugin folder, then try again${fallback}.`;
	}

	private async attemptBiometric(): Promise<void> {
		if (this.busy) return;
		this.setBusy(true, `Waiting for ${this.methodName}…`);
		this.setStatus(`Waiting for ${this.methodName}…`);

		const result = await this.plugin.runBiometricAuth();
		this.setBusy(false);

		// The vault may have been unlocked another way (e.g. password) while we waited.
		if (!this.overlayEl) return;

		switch (result.status) {
			case "success":
				this.plugin.unlock();
				return;
			case "failed":
				this.setStatus(`${this.methodName} failed: ${result.message}`, true);
				return;
			case "unavailable":
				this.setStatus(`${this.methodName} unavailable: ${result.message}`, true);
				return;
			case "not-installed":
				this.setStatus(this.notInstalledMessage(), true);
				return;
		}
	}

	private async attemptSecurityKey(): Promise<void> {
		if (this.busy) return;
		this.setBusy(true);
		this.setStatus("Waiting for security key… Insert and touch your key.");

		const result = await this.plugin.runSecurityKeyAuth();
		this.setBusy(false);
		if (!this.overlayEl) return;

		switch (result.status) {
			case "success":
				this.plugin.unlock();
				return;
			case "failed":
				this.setStatus(`Security key failed: ${result.message}`, true);
				return;
			case "unavailable":
				this.setStatus(`Security key unavailable: ${result.message}`, true);
				return;
		}
	}

	private async attemptPassword(password: string): Promise<void> {
		if (this.busy || !password) return;
		this.setBusy(true);
		const ok = await this.plugin.verifyFallbackPassword(password);
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
