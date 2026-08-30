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
					? " — for example before the native Touch ID helper is built, on an external display, or with a covered sensor."
					: "."),
		});

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
