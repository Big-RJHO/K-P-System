from . import bgs, cgc, psa, tag

GRADERS = {"PSA": psa.grade, "BGS": bgs.grade, "CGC": cgc.grade, "TAG": tag.grade}

__all__ = ["GRADERS"]
