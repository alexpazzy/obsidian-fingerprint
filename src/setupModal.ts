import { App, Modal, Notice, Setting } from "obsidian";
import type TouchIDLockPlugin from "./main";
import { hasFallbackPassword, storeFallbackPassword } from "./settings";
import { getBiometricMethodName, getBiometricPlatform } from "./nativeAuth";

/**
 * Shown once, on the first launch with no saved settings (no data.json).
 * Prompts the user to create a fallback password before the vault ever
 * locks, so a biometric failure can't lock them out. Closing the modal in
 * any way persists settings, which creates data.json and prevents re-prompting.
 */
export class FirstRunSetupModal extends Modal {
	private readonly plugin: TouchIDLockPlugin;
	private readonly onDone: () => void;
	private password = "";
	private confirmPassword = "";
	private saving = false;
	private finished = false;
	private helperStatusEl: HTMLElement | null = null;
	private helperRetryButton: HTMLElement | null = null;

	constructor(app: App, plugin: TouchIDLockPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
	}

	onOpen(): void {
		const { contentEl } = this;
		const method = getBiometricMethodName();

		this.setTitle("Set up Fingerprint Lock");

		contentEl.createEl("p", {
			text:
				`This vault will lock and require ${method} to open. Set a fallback password now, so ` +
				`you can still unlock it if ${method} isn't available` +
				(getBiometricPlatform() === "touchid"
					? " — for example on an external display, with a covered sensor, or if the helper can't be built on this Mac."
					: "."),
		});

		// Install the native helper for the user, rather than asking them to run
		// a build script in a terminal. Status is reported inline below.
		this.helperStatusEl = contentEl.createDiv({ cls: "fingerprint-setup-helper-status" });
		void this.runHelperSetup();

		let passwordInput: HTMLInputElement | null = null;
		new Setting(contentEl).setName("Password").addText((t) => {
			t.inputEl.type = "password";
			passwordInput = t.inputEl;
			t.setPlaceholder("Min. 4 characters");
			t.onChange((v) => (this.password = v));
		});

		new Setting(contentEl).setName("Confirm password").addText((t) => {
			t.inputEl.type = "password";
			t.setPlaceholder("Repeat password");
			t.onChange((v) => (this.confirmPassword = v));
			t.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") void this.save();
			});
		});

		new Setting(contentEl)
			.setName("Encrypt password data (end-to-end)")
			.setDesc(
				"Store only an AES-256-GCM encrypted verifier — the key is derived from your password " +
					"and never leaves this device. You can change this later in settings."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.passwordEncrypted).onChange((v) => {
					this.plugin.settings.passwordEncrypted = v;
				})
			);

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText("Save password")
					.onClick(() => void this.save())
			)
			.addButton((b) =>
				b.setButtonText("Skip for now").onClick(() => {
					this.close();
				})
			);

		window.setTimeout(() => passwordInput?.focus(), 50);
	}

	/** Installs/compiles the biometric helper, reporting progress in the modal. */
	private async runHelperSetup(force = false): Promise<void> {
		const method = getBiometricMethodName();
		const isMac = getBiometricPlatform() === "touchid";
		this.setHelperStatus(
			isMac ? `Building the ${method} helper…` : `Setting up the ${method} helper…`,
			"pending"
		);
		this.helperRetryButton?.toggleClass("fingerprint-hidden", true);

		const result = await this.plugin.setUpNativeHelper({ force });
		if (!this.helperStatusEl) return;

		if (result.status === "ready") {
			this.setHelperStatus(`${method} is ready to use.`, "ok");
			return;
		}
		if (result.status === "unsupported") {
			this.setHelperStatus(result.message, "warn");
			return;
		}
		this.setHelperStatus(`${result.message} You can still use a password below.`, "warn");
		this.showHelperRetry();
	}

	private setHelperStatus(text: string, kind: "pending" | "ok" | "warn"): void {
		const el = this.helperStatusEl;
		if (!el) return;
		el.setText(text);
		el.toggleClass("fingerprint-setup-status-ok", kind === "ok");
		el.toggleClass("fingerprint-setup-status-warn", kind === "warn");
	}

	private showHelperRetry(): void {
		if (this.helperRetryButton) {
			this.helperRetryButton.toggleClass("fingerprint-hidden", false);
			return;
		}
		const setting = new Setting(this.contentEl).setName("Retry helper setup").addButton((b) =>
			b.setButtonText("Try again").onClick(() => void this.runHelperSetup(true))
		);
		this.helperRetryButton = setting.settingEl;
		// Keep the retry row directly under the status line it belongs to.
		this.helperStatusEl?.insertAdjacentElement("afterend", setting.settingEl);
	}

	private async save(): Promise<void> {
		if (this.saving) return;
		if (this.password.length < 4) {
			new Notice("Password must be at least 4 characters.");
			return;
		}
		if (this.password !== this.confirmPassword) {
			new Notice("Passwords don't match.");
			return;
		}
		this.saving = true;
		try {
			await storeFallbackPassword(this.plugin.settings, this.password);
			this.plugin.settings.passwordFallbackEnabled = true;
			new Notice("Fallback password saved.");
		} finally {
			this.saving = false;
		}
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.finished) return;
		this.finished = true;
		// Persist whatever was chosen (possibly just defaults). This writes
		// data.json, so the prompt won't reappear on the next launch.
		void this.plugin.saveSettings().then(() => {
			if (!hasFallbackPassword(this.plugin.settings)) {
				new Notice(
					"No fallback password set. You can add one anytime in Settings → Fingerprint Lock.",
					8000
				);
			}
			this.onDone();
		});
	}
}
