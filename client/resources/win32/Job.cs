using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal static partial class Sandbox
{
    [StructLayout(LayoutKind.Sequential)] internal struct BasicProcessInfo {
        internal IntPtr Exit, Peb, Affinity, Priority, Id, Parent;
    }
    [DllImport("ntdll.dll")] internal static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out BasicProcessInfo info, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    internal static IntPtr ParentHandle()
    {
        BasicProcessInfo info; int returned;
        using (Process current = Process.GetCurrentProcess()) {
            if (NtQueryInformationProcess(current.Handle, 0, out info, Marshal.SizeOf(typeof(BasicProcessInfo)), out returned) != 0)
                throw new InvalidOperationException("Cannot identify sandbox owner");
            IntPtr parent = OpenProcess(0x101000, false, checked((uint)info.Parent.ToInt64()));
            if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot monitor sandbox owner");
            long creation, exit, kernel, user;
            if (!GetProcessTimes(parent, out creation, out exit, out kernel, out user) || creation > current.StartTime.ToFileTimeUtc()) {
                CloseHandle(parent); throw new InvalidOperationException("Sandbox owner already exited or PID was reused");
            }
            return parent;
        }
    }
    internal static void TerminateAndDrain(IntPtr job, uint exit)
    {
        Check(TerminateJobObject(job, exit), "Terminate job tree");
        System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
        do {
            Accounting accounting;
            Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "Query job process count");
            if (accounting.ActiveProcesses == 0) return;
            System.Threading.Thread.Sleep(10);
        } while (clock.ElapsedMilliseconds < 5000);
        throw new TimeoutException("Job tree did not exit");
    }
    internal static IntPtr CreateJob(uint activeProcesses = 8)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Create sandbox job");
        Limits limits = new Limits();
        // Kill-on-close, commit limits, caller-fixed active cap (production RUN = 1), 120s aggregate CPU.
        limits.Basic.Flags = 0x2000 | 0x100 | 0x200 | 0x8 | 0x4;
        limits.Basic.ActiveProcesses = activeProcesses;
        limits.Basic.JobTime = 120L * 10000000;
        limits.ProcessMemory = new UIntPtr(512UL * 1024 * 1024);
        limits.JobMemory = new UIntPtr(768UL * 1024 * 1024);
        try { Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Limits))), "Set sandbox job limits"); }
        catch { CloseHandle(job); throw; }
        return job;
    }
}
